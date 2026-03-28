import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import * as mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

import { evaluateTicker, computeComposite } from "./engine/scoring.js";
import { CONFIG, similarityToFactorScore } from "./config.js";
import { scoreToSignal } from "./factors/factor-base.js";
import { FMPClient } from "./api/fmp.js";
import {
  getWatchlist, addToWatchlist, removeFromWatchlist,
  getTickerData, saveTickerData,
} from "./storage.js";
import { clearAllCache, getCacheStats } from "./services/apiCache.js";
import { batchEvaluate, loadBatchResults } from "./services/batchEvaluate.js";
import { recordSignal, getRecentChanges, getLastSignalChange } from "./services/signalHistory.js";
import {
  getTagStore, createTag, deleteTag, renameTag,
  assignTag, removeTagFromTicker, getTickerTags, getDefaultSuggestedTags,
} from "./services/watchlistTags.js";

// ══════════════════════════════════════════════════════════════════════════════
// STOP WORDS & SENTIMENT (Loughran-McDonald)
// ══════════════════════════════════════════════════════════════════════════════
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","shall","should","may","might","can","could","it",
  "its","this","that","these","those","we","our","us","they","their","he","she",
  "as","not","no","nor","so","if","then","than","any","all","each","both","few",
  "more","most","other","such","into","through","during","before","after","above",
  "below","between","out","off","over","under","again","further","once","here",
  "there","where","why","how","what","which","who","whom","i","you","your","my",
]);
const NEGATIVE_WORDS = new Set([
  "loss","losses","decline","declines","declined","decrease","decreases","decreased",
  "impairment","impairments","adverse","adversely","unfavorable","unfavorably",
  "risk","risks","uncertainty","uncertainties","litigation","lawsuit","lawsuits",
  "penalty","penalties","recall","recalls","violation","violations","failure",
  "failures","default","defaults","bankruptcy","bankrupt","breach","breaches",
  "deficiency","deficiencies","investigation","investigations","fraud","alleged",
  "allegations","uncertain","volatile","volatility","exposure","challenge",
  "challenges","deterioration","deteriorated","discontinued","discontinue",
  "concern","concerns","shortage","shortages","delay","delays","delayed","weak",
  "weakness","weaknesses","negative","negatively","deficit","deficits","material",
  "restatement","restated","noncompliance","impair","impaired",
]);

// ══════════════════════════════════════════════════════════════════════════════
// TOKENIZATION
// ══════════════════════════════════════════════════════════════════════════════
function tokenize(text, removeStop = false) {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  return removeStop ? tokens.filter((t) => !STOP_WORDS.has(t)) : tokens;
}
function sentimentScore(tokens) {
  return tokens.length > 0 ? tokens.filter((t) => NEGATIVE_WORDS.has(t)).length / tokens.length : 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// FOUR SIMILARITY MEASURES (Cohen, Malloy & Nguyen 2018)
// ══════════════════════════════════════════════════════════════════════════════
function cosineSimilarity(tA, tB) {
  const fA = {}, fB = {};
  tA.forEach((t) => { fA[t] = (fA[t] || 0) + 1; });
  tB.forEach((t) => { fB[t] = (fB[t] || 0) + 1; });
  const vocab = new Set([...Object.keys(fA), ...Object.keys(fB)]);
  let dot = 0, nA = 0, nB = 0;
  vocab.forEach((t) => { const a = fA[t]||0, b = fB[t]||0; dot+=a*b; nA+=a*a; nB+=b*b; });
  return nA && nB ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}
function jaccardSimilarity(tA, tB) {
  const sA = new Set(tA), sB = new Set(tB);
  let inter = 0; sA.forEach((t) => { if (sB.has(t)) inter++; });
  const union = sA.size + sB.size - inter;
  return union ? inter / union : 1;
}
function minEditSimilarity(tA, tB) {
  const a = tA.slice(0, 400), b = tB.slice(0, 400), m = a.length, n = b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return Math.max(0, 1 - dp[m][n] / (Math.max(m, n) || 1));
}
function simpleSimilarity(tA, tB) {
  const a = tA.slice(0,500), b = tB.slice(0,500), m=a.length, n=b.length;
  const dp = Array.from({length:m+1},()=>new Int16Array(n+1));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);
  const lcs=dp[m][n], changes=(m-lcs)+(n-lcs), avg=(m+n)/2||1;
  return Math.max(0,(2-changes/avg)/2);
}
function computeAllScores(tA, tB) {
  const cosine=cosineSimilarity(tA,tB), jaccard=jaccardSimilarity(tA,tB);
  const minEdit=minEditSimilarity(tA,tB), simple=simpleSimilarity(tA,tB);
  return { cosine, jaccard, minEdit, simple, avg:(cosine+jaccard+minEdit+simple)/4 };
}

// ══════════════════════════════════════════════════════════════════════════════
// LCS DIFF
// ══════════════════════════════════════════════════════════════════════════════
function computeDiff(tA, tB) {
  const a=tA.slice(0,400), b=tB.slice(0,400), m=a.length, n=b.length;
  const dp=Array.from({length:m+1},()=>new Int16Array(n+1));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);
  const ops=[]; let i=m,j=n;
  while(i>0||j>0){
    if(i>0&&j>0&&a[i-1]===b[j-1]){ops.push({type:"same",word:a[i-1]});i--;j--;}
    else if(j>0&&(i===0||dp[i][j-1]>=dp[i-1][j])){ops.push({type:"add",word:b[j-1]});j--;}
    else{ops.push({type:"del",word:a[i-1]});i--;}
  }
  return ops.reverse();
}

// ══════════════════════════════════════════════════════════════════════════════
// FILE PARSING
// ══════════════════════════════════════════════════════════════════════════════
async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext==="txt"||ext==="csv") {
    return new Promise((res,rej)=>{
      const r=new FileReader(); r.onload=(e)=>res(e.target.result); r.onerror=()=>rej(new Error("Could not read file")); r.readAsText(file);
    });
  }
  if (ext==="docx") {
    const buf=await file.arrayBuffer(); const result=await mammoth.extractRawText({arrayBuffer:buf});
    if(!result.value.trim()) throw new Error("No text found in .docx"); return result.value;
  }
  if (ext==="pdf") {
    const buf=await file.arrayBuffer(); const pdf=await pdfjsLib.getDocument({data:buf}).promise;
    let text="";
    for(let p=1;p<=pdf.numPages;p++){const page=await pdf.getPage(p);const content=await page.getTextContent();text+=content.items.map((i)=>i.str).join(" ")+"\n";}
    if(!text.trim()) throw new Error("No text extracted — PDF may be image-based"); return text;
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 10-K SIGNAL CLASSIFICATION (quintile mapping from the paper)
// ══════════════════════════════════════════════════════════════════════════════
function classifySignal(avg) {
  if (avg >= 0.85) return {
    tier: 5, label: "Strong Long", badge: "LONG", color: "#4ade80",
    bgColor: "rgba(74,222,128,0.08)", borderColor: "rgba(74,222,128,0.25)",
    arrow: "\u25B2", alphaRange: "+21 to +30 bps/month",
    annualized: "~+3.5% per year (risk-adjusted)",
    plain: "Filing is nearly identical to the prior year — non-changer signal.",
    paperRef: "Cohen et al. (2018) Table II: Q5 (non-changers) earns +21\u201330 bps/month 5-factor alpha.",
  };
  if (avg >= 0.72) return {
    tier: 4, label: "Mild Long", badge: "MILD LONG", color: "#86efac",
    bgColor: "rgba(134,239,172,0.06)", borderColor: "rgba(134,239,172,0.2)",
    arrow: "\u2197", alphaRange: "+10 to +20 bps/month",
    annualized: "~+1.5% per year (risk-adjusted)",
    plain: "Minor changes from last year\u2019s filing. Historically correlates with modestly positive returns.",
    paperRef: "Cohen et al. (2018) Table II: Q4 portfolio earns modest positive alpha.",
  };
  if (avg >= 0.58) return {
    tier: 3, label: "Neutral", badge: "NEUTRAL", color: "#facc15",
    bgColor: "rgba(250,204,21,0.06)", borderColor: "rgba(250,204,21,0.2)",
    arrow: "\u2192", alphaRange: "~0 bps/month",
    annualized: "No significant alpha expected",
    plain: "Moderate level of change. Falls roughly in the middle of the paper\u2019s quintile distribution.",
    paperRef: "Cohen et al. (2018) Table II: Q3 is statistically indistinguishable from zero.",
  };
  if (avg >= 0.42) return {
    tier: 2, label: "Mild Short", badge: "MILD SHORT", color: "#fb923c",
    bgColor: "rgba(251,146,60,0.06)", borderColor: "rgba(251,146,60,0.2)",
    arrow: "\u2198", alphaRange: "\u221210 to \u221220 bps/month",
    annualized: "~\u22121.5% per year (risk-adjusted)",
    plain: "Meaningful language changes versus last year. Associated with negative future returns.",
    paperRef: "Cohen et al. (2018) Table II: Q2 portfolio earns modest negative alpha.",
  };
  return {
    tier: 1, label: "Strong Short", badge: "SHORT", color: "#f87171",
    bgColor: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.3)",
    arrow: "\u25BC", alphaRange: "\u221234 to \u221258 bps/month",
    annualized: "~\u22125 to \u22127% per year (risk-adjusted)",
    plain: "Major changes from the prior year\u2019s filing \u2014 bottom quintile of similarity (Q1). Strong changer signal.",
    paperRef: "Cohen et al. (2018) Table II: Q1 earns \u221234 to \u221258 bps/month 5-factor alpha.",
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function parseRoute() {
  const hash = (window.location.hash || "").slice(1) || "/";
  const m = hash.match(/^\/ticker\/(.+)$/);
  if (m) return { view: "profile", ticker: m[1].toUpperCase() };
  return { view: "watchlist", ticker: null };
}
function navigate(path) { window.location.hash = path; }
function useHashRouter() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const h = () => setRoute(parseRoute());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return route;
}

function formatAge(ts) {
  if (!ts) return "Never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLE CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const CARD = { background:"#0b1420", borderRadius:12, padding:"20px 22px", border:"1px solid #1a2d40" };
const SIGNAL_META = {
  BUY:  { color:"#4ade80", bg:"rgba(74,222,128,0.08)",  border:"rgba(74,222,128,0.3)" },
  HOLD: { color:"#facc15", bg:"rgba(250,204,21,0.06)",  border:"rgba(250,204,21,0.25)" },
  SELL: { color:"#f87171", bg:"rgba(248,113,113,0.08)", border:"rgba(248,113,113,0.3)" },
};
const FACTOR_COLOR = { BULLISH:"#4ade80", BEARISH:"#f87171", NEUTRAL:"#facc15", ERROR:"#3a5a7a" };
const LABEL = { color:"#3a5a7a", fontSize:11, letterSpacing:1, fontWeight:700 };
const VAL   = { color:"#7a9abf", fontSize:12 };
const SECTION_TITLE = { color:"#1e4a8a", fontSize:11, letterSpacing:1.5, fontWeight:700 };

// ══════════════════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

function ScoreBar({ score }) {
  if (score === null || score === undefined) return <span style={{color:"#3a5a7a",fontSize:11}}>N/A</span>;
  const pct = Math.round((score + 1) / 2 * 100);
  const color = score >= 0.25 ? "#4ade80" : score <= -0.25 ? "#f87171" : "#facc15";
  return (
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <div style={{width:80,height:6,background:"#0c1824",borderRadius:3,overflow:"hidden",flexShrink:0}}>
        <div style={{width:`${pct}%`,height:"100%",background:color,borderRadius:3,transition:"width 0.4s"}}/>
      </div>
      <span style={{color,fontSize:12,fontWeight:600,minWidth:40}}>{score > 0 ? "+" : ""}{score.toFixed(2)}</span>
    </div>
  );
}

function ScoreRing({ value, label, color, size=88 }) {
  const r=size*0.41, cx=size/2, cy=size/2, circ=2*Math.PI*r;
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e2a3a" strokeWidth={7}/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={7}
          strokeDasharray={`${(value*circ).toFixed(2)} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{transition:"stroke-dasharray 0.6s cubic-bezier(.4,0,.2,1)"}}/>
        <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle"
          style={{fill:"#c8daf0",fontFamily:"'DM Mono',monospace",fontSize:size*0.18,fontWeight:700}}>
          {Math.round(value*100)}%
        </text>
      </svg>
      <span style={{color:"#5a7a9a",fontSize:12,letterSpacing:1,textTransform:"uppercase"}}>{label}</span>
    </div>
  );
}

function DiffViewer({ diff }) {
  return (
    <div style={{fontSize:13,lineHeight:2,background:"#060d18",borderRadius:10,padding:"18px 20px",maxHeight:260,overflowY:"auto",wordBreak:"break-word",border:"1px solid #1a2d40"}}>
      {diff.map((op,i)=>{
        if(op.type==="same") return <span key={i} style={{color:"#2a4060"}}>{op.word} </span>;
        if(op.type==="add")  return <span key={i} style={{color:"#4ade80",background:"rgba(74,222,128,0.08)",borderRadius:4,padding:"1px 4px",marginRight:3}}>+{op.word} </span>;
        return <span key={i} style={{color:"#f87171",background:"rgba(248,113,113,0.08)",borderRadius:4,padding:"1px 4px",marginRight:3,textDecoration:"line-through",opacity:.75}}>-{op.word} </span>;
      })}
    </div>
  );
}

function DropZone({ onFiles, label }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  const handle = useCallback((files) => {
    const valid = Array.from(files).filter(f=>["txt","pdf","docx","csv"].includes(f.name.split(".").pop().toLowerCase()));
    if(valid.length) onFiles(valid);
  }, [onFiles]);
  return (
    <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files);}}
      onClick={()=>ref.current.click()}
      style={{border:`2px dashed ${drag?"#2a6bbf":"#1e3050"}`,borderRadius:12,padding:"20px 16px",
        textAlign:"center",cursor:"pointer",background:drag?"rgba(42,107,191,0.06)":"#080f1c",transition:"all 0.2s"}}>
      <input ref={ref} type="file" multiple accept=".txt,.pdf,.docx,.csv" style={{display:"none"}} onChange={e=>handle(e.target.files)}/>
      <div style={{color:"#4a7aaa",fontSize:13,fontWeight:600,marginBottom:4}}>{label || "Drop files or click to browse"}</div>
      <div style={{color:"#1e3050",fontSize:11}}>Accepts .txt .pdf .docx .csv</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// FACTOR DETAIL PANEL (expandable per-factor detail)
// ══════════════════════════════════════════════════════════════════════════════

function FactorDetailPanel({ factor }) {
  const d = factor.details || {};
  const box = {background:"#060d18",border:"1px solid #0c1824",borderRadius:8,padding:"14px 16px",marginTop:8};
  if (d.error) return <div style={box}><span style={{color:"#f87171",fontSize:12}}>{d.error}</span></div>;

  // Earnings Growth
  if (d.trajectory !== undefined && d.yoy_eps_growth_pct !== undefined) {
    return (
      <div style={box}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <div><div style={LABEL}>TRAJECTORY</div><div style={{...VAL,color:"#c8daf0"}}>{d.trajectory?.replace(/_/g," ")}</div></div>
          <div><div style={LABEL}>YOY EPS GROWTH</div><div style={{...VAL,color:(d.yoy_eps_growth_pct??0)>=0?"#4ade80":"#f87171"}}>{d.yoy_eps_growth_pct!==null?((d.yoy_eps_growth_pct>0?"+":"")+d.yoy_eps_growth_pct?.toFixed(2)+"%"):"N/A"}</div></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
          {d.quarters?.map((q,i)=>(
            <div key={i} style={{background:"#080f1c",borderRadius:6,padding:"8px 10px",border:"1px solid #0c1824"}}>
              <div style={{color:"#1e3050",fontSize:10,marginBottom:4}}>{q.date}</div>
              <div style={{color:"#7a9abf",fontSize:11}}>EPS: <span style={{color:"#c8daf0"}}>${q.eps?.toFixed(2)}</span></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Revenue Growth
  if (d.trend !== undefined && (d.latest_yoy_pct !== undefined || d.latest_qoq_pct !== undefined) && d.slope_pp_per_quarter === undefined) {
    return (
      <div style={box}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
          <div><div style={LABEL}>TREND</div><div style={{...VAL,color:"#c8daf0"}}>{d.trend}</div></div>
          {d.latest_yoy_pct!==null&&<div><div style={LABEL}>YOY</div><div style={{...VAL,color:d.latest_yoy_pct>=0?"#4ade80":"#f87171"}}>{d.latest_yoy_pct>0?"+":""}{d.latest_yoy_pct?.toFixed(1)}%</div></div>}
          {d.latest_qoq_pct!==null&&<div><div style={LABEL}>QOQ</div><div style={{...VAL,color:d.latest_qoq_pct>=0?"#4ade80":"#f87171"}}>{d.latest_qoq_pct>0?"+":""}{d.latest_qoq_pct?.toFixed(1)}%</div></div>}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {d.quarters?.map((q,i)=>(
            <div key={i} style={{background:"#080f1c",borderRadius:6,padding:"8px 10px",border:"1px solid #0c1824",minWidth:120}}>
              <div style={{color:"#1e3050",fontSize:10,marginBottom:4}}>{q.date}</div>
              <div style={{color:"#7a9abf",fontSize:11}}>Rev: <span style={{color:"#c8daf0"}}>${(q.revenue/1e9).toFixed(1)}B</span></div>
              {q.qoq_growth_pct!==null&&<div style={{color:q.qoq_growth_pct>=0?"#4ade80":"#f87171",fontSize:11}}>QoQ: {q.qoq_growth_pct>0?"+":""}{q.qoq_growth_pct?.toFixed(1)}%</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Gross Margin
  if (d.slope_pp_per_quarter !== undefined) {
    return (
      <div style={box}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
          <div><div style={LABEL}>TREND</div><div style={{...VAL,color:"#c8daf0"}}>{d.trend}</div></div>
          <div><div style={LABEL}>MARGIN CHANGE</div><div style={{...VAL,color:d.margin_change_pp>=0?"#4ade80":"#f87171"}}>{d.margin_change_pp>0?"+":""}{d.margin_change_pp?.toFixed(2)}pp</div></div>
          <div><div style={LABEL}>VOLATILITY</div><div style={{...VAL,color:d.is_volatile?"#fb923c":"#7a9abf"}}>{d.volatility?.toFixed(2)}pp</div></div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {d.quarters?.map((q,i)=>(
            <div key={i} style={{background:"#080f1c",borderRadius:6,padding:"8px 10px",border:"1px solid #0c1824",minWidth:100}}>
              <div style={{color:"#1e3050",fontSize:10,marginBottom:4}}>{q.date}</div>
              <div style={{color:"#c8daf0",fontSize:12,fontWeight:600}}>{q.gross_margin_pct?.toFixed(1)}%</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Accruals
  if (d.accruals_ratio !== undefined) {
    const fmt = (n) => n!=null?(n>0?"+":"")+n.toFixed(4):"N/A";
    return (
      <div style={box}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          <div><div style={LABEL}>NET INCOME</div><div style={VAL}>${(d.net_income/1e9).toFixed(2)}B</div></div>
          <div><div style={LABEL}>OPER. CASH FLOW</div><div style={VAL}>${(d.operating_cash_flow/1e9).toFixed(2)}B</div></div>
          <div><div style={LABEL}>TOTAL ASSETS</div><div style={VAL}>${(d.total_assets/1e9).toFixed(1)}B</div></div>
          <div><div style={LABEL}>ACCRUALS RATIO</div><div style={{...VAL,color:d.accruals_ratio<0?"#4ade80":"#f87171",fontWeight:600}}>{fmt(d.accruals_ratio)}</div></div>
          {d.accruals_change!==null&&<div><div style={LABEL}>YOY CHANGE</div><div style={{...VAL,color:d.accruals_change<=0?"#4ade80":"#f87171"}}>{fmt(d.accruals_change)}</div></div>}
        </div>
      </div>
    );
  }

  // Price Momentum
  if (d.momentum_return_pct !== undefined) {
    return (
      <div style={box}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          <div><div style={LABEL}>12M AGO</div><div style={VAL}>${d.price_12m_ago} <span style={{fontSize:10,color:"#1e3050"}}>({d.date_12m_ago})</span></div></div>
          <div><div style={LABEL}>1M AGO</div><div style={VAL}>${d.price_1m_ago}</div></div>
          <div><div style={LABEL}>CURRENT</div><div style={VAL}>${d.price_current}</div></div>
          <div><div style={LABEL}>12-1 MOMENTUM</div><div style={{...VAL,color:d.momentum_return_pct>=0?"#4ade80":"#f87171",fontWeight:700,fontSize:14}}>{d.momentum_return_pct>0?"+":""}{d.momentum_return_pct?.toFixed(2)}%</div></div>
          <div><div style={LABEL}>RECENT 1M</div><div style={{...VAL,color:d.recent_1m_return_pct>=0?"#4ade80":"#f87171"}}>{d.recent_1m_return_pct>0?"+":""}{d.recent_1m_return_pct?.toFixed(2)}%</div></div>
        </div>
      </div>
    );
  }

  // Insider Trading
  if (d.buyVolume !== undefined && d.sellVolume !== undefined && d.netRatio !== undefined) {
    const fmtDollar = (n) => n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(0)}K` : `$${n}`;
    return (
      <div style={box}>
        {d.note ? (
          <div style={{color:"#5a7a9a",fontSize:12}}>{d.note}</div>
        ) : (
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
              <div><div style={LABEL}>BUY VOLUME</div><div style={{...VAL,color:"#4ade80"}}>{fmtDollar(d.buyVolume)}</div></div>
              <div><div style={LABEL}>SELL VOLUME</div><div style={{...VAL,color:"#f87171"}}>{fmtDollar(d.sellVolume)}</div></div>
              <div><div style={LABEL}>NET RATIO</div><div style={{...VAL,color:d.netRatio>=0?"#4ade80":"#f87171",fontWeight:700}}>{d.netRatio>0?"+":""}{d.netRatio.toFixed(3)}</div></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
              <div><div style={LABEL}>TRANSACTIONS</div><div style={VAL}>{d.totalTransactions} ({d.buyCount} buys, {d.sellCount} sells)</div></div>
              <div><div style={LABEL}>UNIQUE BUYERS</div><div style={VAL}>{d.uniqueBuyers}{d.clusterMultiplier>1?` (${d.clusterMultiplier}x cluster bonus)`:""}</div></div>
              <div><div style={LABEL}>CONFIDENCE</div><div style={{...VAL,color:d.confidence==="high"?"#4ade80":d.confidence==="medium"?"#fbbf24":"#5a7a9a"}}>{d.confidence?.toUpperCase()}</div></div>
            </div>
          </>
        )}
      </div>
    );
  }

  // Analyst Dispersion
  if (d.dispersion !== undefined && d.numAnalysts !== undefined) {
    return (
      <div style={box}>
        {d.note ? (
          <div style={{color:"#5a7a9a",fontSize:12}}>{d.note}</div>
        ) : (
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
              <div><div style={LABEL}>EPS ESTIMATES</div><div style={VAL}>{d.epsLow?.toFixed(2)} / <span style={{fontWeight:700,color:"#c8daf0"}}>{d.epsAvg?.toFixed(2)}</span> / {d.epsHigh?.toFixed(2)}</div></div>
              <div><div style={LABEL}>DISPERSION</div><div style={{...VAL,color:d.dispersion<0.25?"#4ade80":d.dispersion<0.50?"#fbbf24":"#f87171",fontWeight:700}}>{d.useAbsoluteSpread?"$":"" }{d.dispersion.toFixed(3)}{d.useAbsoluteSpread?"":" (ratio)"}</div></div>
              <div><div style={LABEL}>ANALYSTS</div><div style={VAL}>{d.numAnalysts} (modifier: {d.modifier})</div></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
              <div><div style={LABEL}>PERIOD</div><div style={VAL}>{d.period}</div></div>
              <div><div style={LABEL}>CONFIDENCE</div><div style={{...VAL,color:d.confidence==="high"?"#4ade80":d.confidence==="medium"?"#fbbf24":"#5a7a9a"}}>{d.confidence?.toUpperCase()}</div></div>
            </div>
          </>
        )}
      </div>
    );
  }

  // 10-K Filing Similarity
  if (d.avg_similarity !== undefined) {
    const sig10k = classifySignal(d.avg_similarity);
    return (
      <div style={box}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:12}}>
          <div><div style={LABEL}>COSINE</div><div style={VAL}>{(d.cosine*100).toFixed(1)}%</div></div>
          <div><div style={LABEL}>JACCARD</div><div style={VAL}>{(d.jaccard*100).toFixed(1)}%</div></div>
          <div><div style={LABEL}>MIN-EDIT</div><div style={VAL}>{(d.minEdit*100).toFixed(1)}%</div></div>
          <div><div style={LABEL}>SIMPLE DIFF</div><div style={VAL}>{(d.simple*100).toFixed(1)}%</div></div>
        </div>
        <div style={{color:"#3a5a7a",fontSize:12,lineHeight:1.6,marginTop:8}}>
          <span style={{color:sig10k.color,fontWeight:700}}>{sig10k.badge}</span> — {sig10k.plain}
        </div>
        <div style={{color:"#1e3050",fontSize:11,marginTop:8,fontStyle:"italic"}}>{sig10k.paperRef}</div>
      </div>
    );
  }

  return <div style={box}><pre style={{color:"#3a5a7a",fontSize:11,margin:0,whiteSpace:"pre-wrap"}}>{JSON.stringify(d,null,2)}</pre></div>;
}

function getKeyDetail(f) {
  const d = f.details || {};
  if (d.error) return d.error;
  if (d.trajectory !== undefined) return `${d.trajectory?.replace(/_/g," ")}, YoY EPS ${d.yoy_eps_growth_pct!=null?(d.yoy_eps_growth_pct>0?"+":"")+d.yoy_eps_growth_pct?.toFixed(1)+"%":"N/A"}`;
  if (d.trend !== undefined && d.slope_pp_per_quarter === undefined) return `${d.trend}, YoY ${d.latest_yoy_pct!=null?(d.latest_yoy_pct>0?"+":"")+d.latest_yoy_pct?.toFixed(1)+"%":"N/A"}`;
  if (d.slope_pp_per_quarter !== undefined) return `${d.trend}, \u0394margin ${d.margin_change_pp>0?"+":""}${d.margin_change_pp?.toFixed(2)}pp`;
  if (d.accruals_ratio !== undefined) return `Ratio ${d.accruals_ratio>0?"+":""}${d.accruals_ratio?.toFixed(4)}`;
  if (d.momentum_return_pct !== undefined) return `12-1 return ${d.momentum_return_pct>0?"+":""}${d.momentum_return_pct?.toFixed(1)}%`;
  if (d.buyVolume !== undefined && d.netRatio !== undefined) return d.totalTransactions===0 ? "No activity" : `${d.buyCount} buys / ${d.sellCount} sells, net ${d.netRatio>0?"+":""}${d.netRatio.toFixed(3)}`;
  if (d.dispersion !== undefined && d.numAnalysts !== undefined) return d.note || `Dispersion ${d.dispersion.toFixed(3)}, ${d.numAnalysts} analysts`;
  if (d.avg_similarity !== undefined) return `${(d.avg_similarity*100).toFixed(1)}% similar \u2014 ${d.classification}`;
  return "";
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPANDABLE FACTOR ROW
// ══════════════════════════════════════════════════════════════════════════════

function FactorRow({ factor, expanded, onToggle }) {
  const sig = factor.signal || "ERROR";
  const sigColor = FACTOR_COLOR[sig] || "#3a5a7a";
  return (
    <div>
      <div onClick={onToggle} style={{
        display:"grid",gridTemplateColumns:"1fr 160px 100px 60px 28px",alignItems:"center",gap:12,
        padding:"10px 14px",background:expanded?"#0d1828":"#080f1c",
        borderRadius:expanded?"8px 8px 0 0":8,border:"1px solid #1a2d40",cursor:"pointer",transition:"background 0.15s"}}>
        <div>
          <div style={{color:"#c8daf0",fontSize:13,fontWeight:600}}>{factor.name}</div>
          <div style={{color:"#3a5a7a",fontSize:11,marginTop:2}}>{getKeyDetail(factor)}</div>
        </div>
        <ScoreBar score={factor.score} />
        <div style={{textAlign:"center",padding:"3px 8px",borderRadius:5,background:`${sigColor}18`,border:`1px solid ${sigColor}44`,color:sigColor,fontSize:11,fontWeight:700,letterSpacing:.5}}>{sig}</div>
        <div style={{color:"#3a5a7a",fontSize:11,textAlign:"right"}}>w={factor.weight}</div>
        <div style={{color:"#3a5a7a",fontSize:13,textAlign:"center"}}>{expanded?"\u25B2":"\u25BC"}</div>
      </div>
      {expanded && <FactorDetailPanel factor={factor} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// FUTURE SIGNAL PLACEHOLDER
// ══════════════════════════════════════════════════════════════════════════════

function FuturePlaceholder({ name, description }) {
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 60px 28px",alignItems:"center",gap:12,
      padding:"10px 14px",background:"#080f1c",borderRadius:8,border:"1px solid #1a2d40",opacity:0.4}}>
      <div>
        <div style={{color:"#5a7a9a",fontSize:13,fontWeight:600}}>{name}</div>
        <div style={{color:"#2a3a4a",fontSize:11,marginTop:2}}>{description}</div>
      </div>
      <span style={{color:"#2a3a4a",fontSize:11}}>Coming soon</span>
      <div style={{textAlign:"center",padding:"3px 8px",borderRadius:5,background:"#0c182418",border:"1px solid #1a2d4044",color:"#2a3a4a",fontSize:11,fontWeight:700}}>---</div>
      <div style={{color:"#2a3a4a",fontSize:11,textAlign:"right"}}>---</div>
      <div/>
    </div>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
// WATCHLIST VIEW (home page)
// ══════════════════════════════════════════════════════════════════════════════

function SignalChangeBadge({ ticker }) {
  const change = getLastSignalChange(ticker);
  if (!change) return null;
  const isUpgrade = change.direction === "upgrade";
  const isDowngrade = change.direction === "downgrade";
  const arrow = isUpgrade ? "\u2191" : isDowngrade ? "\u2193" : "\u2022";
  const color = isUpgrade ? "#4ade80" : isDowngrade ? "#f87171" : "#facc15";
  const bg = isUpgrade ? "rgba(74,222,128,0.1)" : isDowngrade ? "rgba(248,113,113,0.1)" : "rgba(250,204,21,0.08)";
  return (
    <span title={`${change.previousSignal} \u2192 ${change.currentSignal}`}
      style={{display:"inline-flex",alignItems:"center",gap:2,padding:"1px 5px",borderRadius:4,
        background:bg,color,fontSize:9,fontWeight:700,marginLeft:4,letterSpacing:0.3,border:`1px solid ${color}33`}}>
      {arrow} {change.currentSignal}
    </span>
  );
}

function TagPill({ tag, small, onRemove }) {
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:3,padding:small?"1px 5px":"2px 8px",
      borderRadius:10,background:`${tag.color}18`,border:`1px solid ${tag.color}44`,
      color:tag.color,fontSize:small?9:10,fontWeight:600,letterSpacing:0.3,whiteSpace:"nowrap"}}>
      {tag.name}
      {onRemove && (
        <span onClick={e=>{e.stopPropagation();onRemove();}}
          style={{cursor:"pointer",marginLeft:1,opacity:0.7,fontSize:small?8:9}}>\u00d7</span>
      )}
    </span>
  );
}

function TagAssignDropdown({ ticker, onClose, onChange }) {
  const [revision, setRevision] = useState(0);
  const store = getTagStore();
  const assigned = (store.assignments[ticker.toUpperCase()] || []);

  function toggle(tagId) {
    if (assigned.includes(tagId)) {
      removeTagFromTicker(ticker, tagId);
    } else {
      assignTag(ticker, tagId);
    }
    setRevision(n => n + 1);
    if (onChange) onChange();
  }

  return (
    <div onClick={e=>e.stopPropagation()}
      style={{position:"absolute",top:"100%",left:0,zIndex:100,marginTop:4,
        background:"#0b1420",border:"1px solid #1a2d40",borderRadius:8,padding:8,
        minWidth:160,boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}>
      {store.tags.length === 0 ? (
        <div style={{color:"#3a5a7a",fontSize:11,padding:4}}>No tags yet. Create one above.</div>
      ) : store.tags.map(tag => {
        const checked = assigned.includes(tag.id);
        return (
          <div key={tag.id} onClick={()=>toggle(tag.id)}
            style={{display:"flex",alignItems:"center",gap:8,padding:"5px 6px",borderRadius:4,cursor:"pointer",
              background:checked?"rgba(42,107,191,0.08)":"transparent"}}
            onMouseEnter={e=>e.currentTarget.style.background=checked?"rgba(42,107,191,0.12)":"#0d1828"}
            onMouseLeave={e=>e.currentTarget.style.background=checked?"rgba(42,107,191,0.08)":"transparent"}>
            <span style={{width:12,height:12,borderRadius:3,border:`1px solid ${tag.color}`,
              background:checked?tag.color:"transparent",display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:8,color:"#fff",fontWeight:700}}>{checked?"\u2713":""}</span>
            <span style={{color:tag.color,fontSize:11,fontWeight:600}}>{tag.name}</span>
          </div>
        );
      })}
      <div onClick={onClose} style={{marginTop:4,padding:"4px 6px",textAlign:"center",color:"#3a5a7a",fontSize:10,cursor:"pointer",
        borderTop:"1px solid #1a2d40"}}>Done</div>
    </div>
  );
}

function WatchlistView() {
  const [watchlist, setWatchlist] = useState(getWatchlist);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  // Batch evaluate state
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null); // { current, total, ticker }
  const [batchResults, setBatchResults] = useState(() => loadBatchResults());
  const [sortCol, setSortCol] = useState("compositeScore");
  const [sortAsc, setSortAsc] = useState(false);
  // Refresh counter to force re-read of tickerData after batch
  const [refreshKey, setRefreshKey] = useState(0);

  // Tag state
  const [tagStore, setTagStore] = useState(getTagStore);
  const [selectedTags, setSelectedTags] = useState([]); // array of tag IDs for filtering
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [editingTag, setEditingTag] = useState(null); // { id, name } for rename
  const [tagDropdown, setTagDropdown] = useState(null); // ticker symbol or null
  const [tagRevision, setTagRevision] = useState(0); // forces re-render when tags assigned
  const [showManageTags, setShowManageTags] = useState(false);
  const tagInputRef = useRef(null);
  const renameInputRef = useRef(null);

  // Load cached data for all tickers
  const tickerData = useMemo(() => {
    const map = {};
    watchlist.forEach(t => { map[t] = getTickerData(t); });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist, refreshKey]);

  // Recent signal changes (last 7 days)
  const recentChanges = useMemo(() => {
    return getRecentChanges(watchlist, 7);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist, refreshKey]);

  // Build a set of tickers with signal changes from last batch
  const batchSignalChanges = useMemo(() => {
    const map = {};
    if (batchResults?.signalChanges) {
      for (const c of batchResults.signalChanges) {
        map[c.ticker] = c;
      }
    }
    return map;
  }, [batchResults]);

  // Filter watchlist by selected tags
  const filteredWatchlist = useMemo(() => {
    if (selectedTags.length === 0) return watchlist;
    const store = getTagStore();
    return watchlist.filter(sym => {
      const ids = store.assignments[sym] || [];
      return selectedTags.some(tagId => ids.includes(tagId));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist, selectedTags, tagRevision]);

  async function handleAdd() {
    const sym = input.toUpperCase().trim();
    if (!sym || watchlist.includes(sym)) { setInput(""); return; }
    setAdding(true);
    setAddError(null);
    try {
      const client = new FMPClient();
      const q = await client.quote(sym);
      const arr = Array.isArray(q) ? q : [];
      if (arr.length === 0 || !arr[0]?.symbol) throw new Error(`Ticker "${sym}" not found`);
      saveTickerData(sym, { ticker: sym, companyName: arr[0].name || sym, price: arr[0].price ?? null, factors: [], filing: null });
      const newList = addToWatchlist(sym);
      setWatchlist([...newList]);
      setInput("");
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  function handleRemove(sym) {
    const newList = removeFromWatchlist(sym);
    setWatchlist([...newList]);
  }

  async function handleBatchEvaluate() {
    setBatchRunning(true);
    setBatchProgress({ current: 0, total: watchlist.length, ticker: "" });
    try {
      const { results, signalChanges } = await batchEvaluate(watchlist, (current, total, ticker) => {
        setBatchProgress({ current, total, ticker });
      });
      setBatchResults({ results, signalChanges, completedAt: new Date().toISOString() });
      setRefreshKey(k => k + 1);
    } finally {
      setBatchRunning(false);
      setBatchProgress(null);
    }
  }

  function handleSort(col) {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(false); }
  }

  // Tag handlers
  function handleCreateTag(name) {
    if (!name.trim()) return;
    createTag(name);
    setTagStore(getTagStore());
    setTagInput("");
    setShowTagInput(false);
  }

  function handleDeleteTag(tagId) {
    deleteTag(tagId);
    setSelectedTags(s => s.filter(id => id !== tagId));
    setTagStore(getTagStore());
    setShowManageTags(false);
  }

  function handleRenameTag(tagId, newName) {
    if (!newName.trim()) return;
    renameTag(tagId, newName);
    setTagStore(getTagStore());
    setEditingTag(null);
  }

  function toggleTagFilter(tagId) {
    setSelectedTags(s => s.includes(tagId) ? s.filter(id => id !== tagId) : [...s, tagId]);
  }

  // Sort batch results
  const sortedBatchResults = useMemo(() => {
    if (!batchResults?.results) return [];
    // Filter to only tickers still on watchlist
    const filtered = batchResults.results.filter(r => watchlist.includes(r.ticker));
    return [...filtered].sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va === null || va === undefined) va = sortAsc ? Infinity : -Infinity;
      if (vb === null || vb === undefined) vb = sortAsc ? Infinity : -Infinity;
      if (typeof va === "string") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });
  }, [batchResults, sortCol, sortAsc, watchlist]);

  const SORT_HEADER = (label, col) => (
    <span onClick={() => handleSort(col)}
      style={{color: sortCol === col ? "#5a8abf" : "#1e3050", fontSize:10, letterSpacing:1, cursor:"pointer", userSelect:"none"}}>
      {label} {sortCol === col ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
    </span>
  );

  // Focus tag input when shown
  useEffect(() => {
    if (showTagInput && tagInputRef.current) tagInputRef.current.focus();
  }, [showTagInput]);
  useEffect(() => {
    if (editingTag && renameInputRef.current) renameInputRef.current.focus();
  }, [editingTag]);

  // Suggested tags for empty state
  const suggestedTags = getDefaultSuggestedTags();
  const hasNoTags = tagStore.tags.length === 0;

  return (
    <div style={{maxWidth:900,margin:"0 auto",padding:"24px 20px"}}>
      {/* Add ticker bar */}
      <div style={{...CARD,marginBottom:20}}>
        <div style={{display:"flex",gap:10}}>
          <input value={input} onChange={e=>setInput(e.target.value.toUpperCase())}
            onKeyDown={e=>{if(e.key==="Enter"&&!adding)handleAdd();}}
            placeholder="Add ticker symbol (e.g. AAPL)"
            style={{flex:1,background:"#080f1c",border:"1px solid #1a2d40",color:"#c8daf0",padding:"12px 16px",borderRadius:8,fontSize:15,outline:"none",letterSpacing:1}}/>
          <button onClick={handleAdd} disabled={adding||!input.trim()}
            style={{background:adding?"#0c1824":"#1e3a5a",border:`1px solid ${adding?"#1a2d40":"#2a5a8a"}`,
              color:adding?"#3a5a7a":"#c8daf0",padding:"12px 24px",borderRadius:8,cursor:adding?"default":"pointer",
              fontSize:14,fontWeight:700,letterSpacing:1,whiteSpace:"nowrap"}}>
            {adding ? "Adding..." : "Add"}
          </button>
        </div>
        {addError && <div style={{marginTop:10,color:"#f87171",fontSize:12}}>{addError}</div>}
      </div>

      {/* Recent Signal Changes */}
      {recentChanges.length > 0 && (
        <div style={{...CARD,marginBottom:20,padding:"14px 18px",
          background:"linear-gradient(135deg,#0b1420 0%,#0d1828 100%)"}}>
          <div style={{...SECTION_TITLE,marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:13}}>RECENT CHANGES</span>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {recentChanges.map(c => {
              const isUp = c.direction === "upgrade";
              const isDown = c.direction === "downgrade";
              const color = isUp ? "#4ade80" : isDown ? "#f87171" : "#facc15";
              const arrow = isUp ? "\u2191" : isDown ? "\u2193" : "\u2022";
              const daysAgo = Math.round((Date.now() - new Date(c.changedAt).getTime()) / 86400000);
              const ageStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "1d ago" : `${daysAgo}d ago`;
              return (
                <span key={c.ticker} onClick={()=>navigate(`/ticker/${c.ticker}`)}
                  style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",borderRadius:6,
                    background:`${color}0a`,border:`1px solid ${color}30`,cursor:"pointer",transition:"background 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.background=`${color}18`}
                  onMouseLeave={e=>e.currentTarget.style.background=`${color}0a`}>
                  <span style={{color:"#c8daf0",fontSize:12,fontWeight:800,letterSpacing:0.5}}>{c.ticker}</span>
                  <span style={{color:"#3a5a7a",fontSize:10}}>{c.previousSignal}</span>
                  <span style={{color,fontSize:10,fontWeight:700}}>{arrow}</span>
                  <span style={{color,fontSize:10,fontWeight:700}}>{c.currentSignal}</span>
                  <span style={{color:"#2a3a4a",fontSize:9,marginLeft:2}}>{ageStr}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Watchlist table */}
      {watchlist.length === 0 ? (
        <div style={{...CARD,textAlign:"center",padding:"60px 32px"}}>
          <div style={{fontSize:36,marginBottom:16,opacity:0.3}}>+</div>
          <div style={{color:"#2a4060",fontSize:16,marginBottom:8}}>Your watchlist is empty</div>
          <div style={{color:"#1a2840",fontSize:13}}>Add a ticker symbol above to get started. Each ticker gets a full multi-factor evaluation.</div>
        </div>
      ) : (
        <div style={CARD}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
            <div style={SECTION_TITLE}>WATCHLIST — {watchlist.length} TICKER{watchlist.length>1?"S":""}</div>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              {batchProgress && (
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:120,height:4,background:"#0c1824",borderRadius:2,overflow:"hidden"}}>
                    <div style={{width:`${(batchProgress.current/batchProgress.total)*100}%`,height:"100%",background:"#2a6bbf",borderRadius:2,transition:"width 0.3s"}}/>
                  </div>
                  <span style={{color:"#5a8abf",fontSize:11,animation:"pulse 1.5s infinite",whiteSpace:"nowrap"}}>
                    {batchProgress.current}/{batchProgress.total} {batchProgress.ticker}
                  </span>
                </div>
              )}
              <button onClick={handleBatchEvaluate} disabled={batchRunning}
                style={{background:batchRunning?"#0c1824":"#1a3a2a",border:`1px solid ${batchRunning?"#1a2d40":"#2a8a5a"}`,
                  color:batchRunning?"#3a5a7a":"#4ade80",padding:"8px 18px",borderRadius:8,
                  cursor:batchRunning?"default":"pointer",fontSize:12,fontWeight:700,letterSpacing:1,whiteSpace:"nowrap"}}>
                {batchRunning ? "Evaluating..." : "Evaluate All"}
              </button>
            </div>
          </div>

          {/* Tag filter bar */}
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:12,padding:"0 2px"}}>
            <button onClick={()=>setSelectedTags([])}
              style={{padding:"3px 10px",borderRadius:10,fontSize:10,fontWeight:600,letterSpacing:0.3,cursor:"pointer",
                background:selectedTags.length===0?"rgba(42,107,191,0.15)":"transparent",
                border:`1px solid ${selectedTags.length===0?"#2a6bbf":"#1a2d40"}`,
                color:selectedTags.length===0?"#5a8abf":"#3a5a7a",transition:"all 0.15s"}}>
              All
            </button>
            {tagStore.tags.map(tag => {
              const active = selectedTags.includes(tag.id);
              return (
                <button key={tag.id}
                  onClick={()=>toggleTagFilter(tag.id)}
                  onContextMenu={e=>{e.preventDefault();setEditingTag({id:tag.id,name:tag.name});setShowManageTags(true);}}
                  style={{padding:"3px 10px",borderRadius:10,fontSize:10,fontWeight:600,letterSpacing:0.3,cursor:"pointer",
                    background:active?`${tag.color}20`:"transparent",
                    border:`1px solid ${active?tag.color+"66":"#1a2d40"}`,
                    color:active?tag.color:"#3a5a7a",transition:"all 0.15s"}}>
                  {tag.name}
                </button>
              );
            })}
            {showTagInput ? (
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <input ref={tagInputRef} value={tagInput} onChange={e=>setTagInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter")handleCreateTag(tagInput);if(e.key==="Escape"){setShowTagInput(false);setTagInput("");}}}
                  placeholder="Tag name"
                  style={{background:"#080f1c",border:"1px solid #1a2d40",color:"#c8daf0",padding:"3px 8px",
                    borderRadius:6,fontSize:10,outline:"none",width:90}}/>
                <span onClick={()=>handleCreateTag(tagInput)}
                  style={{color:"#4ade80",fontSize:12,cursor:"pointer",fontWeight:700}}>+</span>
                <span onClick={()=>{setShowTagInput(false);setTagInput("");}}
                  style={{color:"#3a5a7a",fontSize:12,cursor:"pointer"}}>\u00d7</span>
              </div>
            ) : (
              <button onClick={()=>setShowTagInput(true)}
                style={{padding:"3px 8px",borderRadius:10,fontSize:10,cursor:"pointer",
                  background:"transparent",border:"1px dashed #1a2d40",color:"#2a4060"}}>
                + Tag
              </button>
            )}
            {tagStore.tags.length > 0 && (
              <span onClick={()=>setShowManageTags(!showManageTags)}
                style={{color:"#2a4060",fontSize:10,cursor:"pointer",marginLeft:4,textDecoration:"underline",
                  textDecorationColor:"#1a2d40"}}>
                Manage
              </span>
            )}
          </div>

          {/* Suggested tags (shown when no tags exist) */}
          {hasNoTags && watchlist.length > 0 && (
            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:12,padding:"0 2px"}}>
              <span style={{color:"#2a3a4a",fontSize:10}}>Suggested:</span>
              {suggestedTags.map(name => (
                <button key={name} onClick={()=>{createTag(name);setTagStore(getTagStore());}}
                  style={{padding:"2px 8px",borderRadius:8,fontSize:9,cursor:"pointer",
                    background:"transparent",border:"1px dashed #1a2d4066",color:"#3a5a7a",transition:"all 0.15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor="#2a5a8a";e.currentTarget.style.color="#5a8abf";}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="#1a2d4066";e.currentTarget.style.color="#3a5a7a";}}>
                  {name}
                </button>
              ))}
            </div>
          )}

          {/* Tag management panel */}
          {showManageTags && tagStore.tags.length > 0 && (
            <div style={{marginBottom:12,padding:10,background:"#080f1c",borderRadius:8,border:"1px solid #1a2d40"}}>
              <div style={{...SECTION_TITLE,fontSize:10,marginBottom:8}}>MANAGE TAGS</div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {tagStore.tags.map(tag => (
                  <div key={tag.id} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 6px"}}>
                    <span style={{width:10,height:10,borderRadius:"50%",background:tag.color,flexShrink:0}}/>
                    {editingTag?.id === tag.id ? (
                      <input ref={renameInputRef} defaultValue={editingTag.name}
                        onKeyDown={e=>{if(e.key==="Enter")handleRenameTag(tag.id,e.target.value);if(e.key==="Escape")setEditingTag(null);}}
                        onBlur={e=>handleRenameTag(tag.id,e.target.value)}
                        style={{background:"#0b1420",border:"1px solid #1a2d40",color:"#c8daf0",padding:"2px 6px",
                          borderRadius:4,fontSize:11,outline:"none",flex:1}}/>
                    ) : (
                      <span style={{color:"#c8daf0",fontSize:11,flex:1}}>{tag.name}</span>
                    )}
                    <span onClick={()=>setEditingTag({id:tag.id,name:tag.name})}
                      style={{color:"#3a5a7a",fontSize:10,cursor:"pointer"}}>Rename</span>
                    <span onClick={()=>handleDeleteTag(tag.id)}
                      style={{color:"#f87171",fontSize:10,cursor:"pointer"}}>Delete</span>
                  </div>
                ))}
              </div>
              <div onClick={()=>setShowManageTags(false)}
                style={{marginTop:6,textAlign:"right",color:"#3a5a7a",fontSize:10,cursor:"pointer"}}>Close</div>
            </div>
          )}

          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {/* Header row */}
            <div style={{display:"grid",gridTemplateColumns:"80px 1fr 100px 90px 90px 80px 40px",gap:12,padding:"0 14px 8px",borderBottom:"1px solid #0c1824"}}>
              <span style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>TICKER</span>
              <span style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>COMPANY</span>
              <span style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>SIGNAL</span>
              <span style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>COMPOSITE</span>
              <span style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>10-K</span>
              <span style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>UPDATED</span>
              <span/>
            </div>
            {filteredWatchlist.map(sym => {
              const td = tickerData[sym];
              const hasFactors = td?.factors?.length > 0;
              const comp = hasFactors ? computeComposite(td.factors) : null;
              const sm = comp ? SIGNAL_META[comp.signal] : null;
              const filing10k = td?.filing?.signal10k;
              const tickerTags = getTickerTags(sym);
              return (
                <div key={sym} onClick={()=>navigate(`/ticker/${sym}`)}
                  style={{display:"grid",gridTemplateColumns:"80px 1fr 100px 90px 90px 80px 40px",gap:12,
                    padding:"12px 14px",borderRadius:8,cursor:"pointer",background:"#080f1c",
                    border:"1px solid #1a2d40",transition:"background 0.15s",alignItems:"center"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#0d1828"}
                  onMouseLeave={e=>e.currentTarget.style.background="#080f1c"}>
                  <span style={{display:"flex",alignItems:"center",gap:2}}>
                    <span style={{color:"#c8daf0",fontSize:15,fontWeight:800,letterSpacing:1}}>{sym}</span>
                    <SignalChangeBadge ticker={sym} />
                  </span>
                  <span style={{display:"flex",alignItems:"center",gap:4,minWidth:0}}>
                    <span style={{color:"#5a7a9a",fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:"0 1 auto",minWidth:0}}>{td?.companyName || "\u2014"}</span>
                    {tickerTags.map(tag => <TagPill key={tag.id} tag={tag} small />)}
                    <span onClick={e=>{e.stopPropagation();setTagDropdown(tagDropdown===sym?null:sym);}}
                      style={{position:"relative",color:"#2a4060",fontSize:10,cursor:"pointer",flexShrink:0,padding:"1px 4px",
                        borderRadius:4,border:"1px solid transparent"}}
                      onMouseEnter={e=>e.currentTarget.style.borderColor="#1a2d40"}
                      onMouseLeave={e=>e.currentTarget.style.borderColor="transparent"}>
                      +tag
                      {tagDropdown === sym && <TagAssignDropdown ticker={sym} onClose={()=>setTagDropdown(null)} onChange={()=>setTagRevision(n=>n+1)} />}
                    </span>
                  </span>
                  {sm ? (
                    <span style={{textAlign:"center",padding:"3px 8px",borderRadius:5,background:`${sm.color}18`,border:`1px solid ${sm.color}44`,color:sm.color,fontSize:11,fontWeight:700,letterSpacing:.5}}>{comp.signal}</span>
                  ) : (
                    <span style={{color:"#2a3a4a",fontSize:11,textAlign:"center"}}>Not evaluated</span>
                  )}
                  <span style={{color:sm?.color||"#2a3a4a",fontSize:13,fontWeight:600}}>{comp ? (comp.composite>0?"+":"") + comp.composite.toFixed(3) : "\u2014"}</span>
                  {filing10k ? (
                    <span style={{textAlign:"center",padding:"2px 6px",borderRadius:5,background:`${filing10k.color}18`,border:`1px solid ${filing10k.color}44`,color:filing10k.color,fontSize:10,fontWeight:700}}>{filing10k.badge}</span>
                  ) : (
                    <span style={{color:"#2a3a4a",fontSize:11,textAlign:"center"}}>\u2014</span>
                  )}
                  <span style={{color:"#2a3a4a",fontSize:11}}>{formatAge(td?.lastUpdated)}</span>
                  <span onClick={e=>{e.stopPropagation();handleRemove(sym);}} style={{color:"#2a4060",fontSize:14,cursor:"pointer",textAlign:"center",borderRadius:4,padding:"2px"}}>\u2715</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Batch Results Table */}
      {sortedBatchResults.length > 0 && !batchRunning && (
        <div style={{...CARD,marginTop:20}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div style={SECTION_TITLE}>BATCH RESULTS</div>
            {batchResults?.completedAt && (
              <span style={{color:"#2a3a4a",fontSize:11}}>
                Evaluated {formatAge(new Date(batchResults.completedAt).getTime())}
              </span>
            )}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {/* Sortable header */}
            <div style={{display:"grid",gridTemplateColumns:"80px 1fr 100px 100px 80px 80px",gap:12,padding:"0 14px 8px",borderBottom:"1px solid #0c1824"}}>
              {SORT_HEADER("TICKER", "ticker")}
              {SORT_HEADER("COMPANY", "companyName")}
              {SORT_HEADER("SIGNAL", "signal")}
              {SORT_HEADER("COMPOSITE", "compositeScore")}
              {SORT_HEADER("CONFIDENCE", "confidence")}
              {SORT_HEADER("CACHE", "fromCache")}
            </div>
            {sortedBatchResults.map(r => {
              const sm = r.signal !== "ERROR" ? SIGNAL_META[r.signal] : null;
              const change = batchSignalChanges[r.ticker];
              const rowBorderColor = change
                ? change.direction === "upgrade" ? "rgba(74,222,128,0.35)"
                : change.direction === "downgrade" ? "rgba(248,113,113,0.35)"
                : "rgba(250,204,21,0.25)"
                : "#1a2d40";
              const rowBg = change
                ? change.direction === "upgrade" ? "rgba(74,222,128,0.04)"
                : change.direction === "downgrade" ? "rgba(248,113,113,0.04)"
                : "rgba(250,204,21,0.03)"
                : "#080f1c";
              const hoverBg = change
                ? change.direction === "upgrade" ? "rgba(74,222,128,0.08)"
                : change.direction === "downgrade" ? "rgba(248,113,113,0.08)"
                : "rgba(250,204,21,0.06)"
                : "#0d1828";
              return (
                <div key={r.ticker} onClick={()=>navigate(`/ticker/${r.ticker}`)}
                  title={change ? `${change.previousSignal} \u2192 ${change.currentSignal}` : ""}
                  style={{display:"grid",gridTemplateColumns:"80px 1fr 100px 100px 80px 80px",gap:12,
                    padding:"10px 14px",borderRadius:8,cursor:"pointer",background:rowBg,
                    borderLeft:change?`3px solid ${rowBorderColor}`:"3px solid transparent",
                    border:`1px solid ${rowBorderColor}`,transition:"background 0.15s",alignItems:"center"}}
                  onMouseEnter={e=>e.currentTarget.style.background=hoverBg}
                  onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
                  <span style={{display:"flex",alignItems:"center",gap:2}}>
                    <span style={{color:"#c8daf0",fontSize:14,fontWeight:800,letterSpacing:1}}>{r.ticker}</span>
                    {change && (
                      <span style={{color:change.direction==="upgrade"?"#4ade80":change.direction==="downgrade"?"#f87171":"#facc15",
                        fontSize:10,fontWeight:700}}>{change.direction==="upgrade"?"\u2191":change.direction==="downgrade"?"\u2193":"\u2022"}</span>
                    )}
                  </span>
                  <span style={{color:"#5a7a9a",fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.companyName || "\u2014"}</span>
                  {sm ? (
                    <span style={{textAlign:"center",padding:"3px 8px",borderRadius:5,background:`${sm.color}18`,border:`1px solid ${sm.color}44`,color:sm.color,fontSize:11,fontWeight:700,letterSpacing:.5}}>{r.signal}</span>
                  ) : (
                    <span style={{textAlign:"center",padding:"3px 8px",borderRadius:5,background:"rgba(248,113,113,0.08)",border:"1px solid rgba(248,113,113,0.3)",color:"#f87171",fontSize:11,fontWeight:700}}>ERROR</span>
                  )}
                  <span style={{color:sm?.color||"#f87171",fontSize:13,fontWeight:600}}>
                    {r.compositeScore !== null ? (r.compositeScore > 0 ? "+" : "") + r.compositeScore.toFixed(3) : r.error ? r.error.slice(0, 20) : "\u2014"}
                  </span>
                  <span style={{color:"#5a7a9a",fontSize:12}}>{r.confidence !== null ? r.confidence + "%" : "\u2014"}</span>
                  <span style={{fontSize:10,padding:"2px 6px",borderRadius:4,
                    background: r.fromCache ? "rgba(74,222,128,0.08)" : "rgba(42,107,191,0.08)",
                    border: `1px solid ${r.fromCache ? "rgba(74,222,128,0.25)" : "rgba(42,107,191,0.25)"}`,
                    color: r.fromCache ? "#4ade80" : "#5a8abf", textAlign:"center"}}>
                    {r.fromCache ? "Cached" : "Fresh"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ASSET PROFILE VIEW (per-ticker detail page)
// ══════════════════════════════════════════════════════════════════════════════

function AssetProfileView({ ticker }) {
  const [data, setData]       = useState(() => getTickerData(ticker));
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [progress, setProgress] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [filingDocs, setFilingDocs] = useState(() => data?.filing?.docs || []);
  const [filingLoading, setFilingLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  // Compute filing similarity whenever docs change
  const filingResult = useMemo(() => {
    if (filingDocs.length < 2) return null;
    const tA = tokenize(filingDocs[0].text, false);
    const tB = tokenize(filingDocs[1].text, false);
    const scores = computeAllScores(tA, tB);
    const factorScore = similarityToFactorScore(scores.avg);
    const signal10k = classifySignal(scores.avg);
    const diff = computeDiff(tokenize(filingDocs[0].text, true), tokenize(filingDocs[1].text, true));
    const sentA = sentimentScore(tA);
    const sentB = sentimentScore(tB);
    return { scores, factorScore, signal10k, diff, sentA, sentB, tokensA: tA.length, tokensB: tB.length };
  }, [filingDocs]);

  // Build the filing factor result for the composite
  const filingFactor = useMemo(() => {
    if (!filingResult) return null;
    return {
      name: "10-K Filing Similarity",
      category: "sophisticated",
      weight: CONFIG.weights.filingSimilarity,
      score: filingResult.factorScore,
      signal: scoreToSignal(filingResult.factorScore),
      details: {
        avg_similarity: filingResult.scores.avg,
        cosine: filingResult.scores.cosine,
        jaccard: filingResult.scores.jaccard,
        minEdit: filingResult.scores.minEdit,
        simple: filingResult.scores.simple,
        classification: filingResult.signal10k.badge,
      },
    };
  }, [filingResult]);

  // Combine API factors + filing factor → composite
  const allFactors = useMemo(() => {
    const factors = [...(data?.factors || [])];
    if (filingFactor) factors.push(filingFactor);
    return factors;
  }, [data?.factors, filingFactor]);

  const composite = useMemo(() => computeComposite(allFactors), [allFactors]);
  const sm = SIGNAL_META[composite.signal];

  // Split factors into sections
  const fundamentals = allFactors.filter(f => f.category === "fundamental");
  const filing10k = allFactors.filter(f => f.name === "10-K Filing Similarity");
  const market = allFactors.filter(f => f.category === "intermediate");

  async function runEvaluation() {
    setLoading(true); setError(null); setProgress([]);
    try {
      const result = await evaluateTicker(ticker, (name, r) => {
        setProgress(p => [...p, { name, signal: r.signal, score: r.score }]);
      });
      const updated = {
        ...data,
        ticker: result.ticker,
        companyName: result.companyName,
        price: result.price,
        factors: result.factors,
        apiCallCount: result.apiCallCount,
        cacheHits: result.cacheHits,
        fromCache: result.fromCache,
        filing: { docs: filingDocs, signal10k: filingResult?.signal10k || null },
      };
      saveTickerData(ticker, updated);
      setData(getTickerData(ticker));

      // Record signal for change tracking
      if (result.signal && result.signal !== "ERROR") {
        recordSignal(ticker, {
          signal: result.signal,
          compositeScore: result.composite,
          confidence: result.confidence,
          evaluatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Handle 10-K file uploads
  async function handleFilingUpload(files) {
    setFilingLoading(true);
    try {
      const newDocs = [...filingDocs];
      for (const file of files) {
        if (newDocs.length >= 2) break;
        const text = await extractText(file);
        newDocs.push({ name: file.name, text });
      }
      const trimmed = newDocs.slice(0, 2);
      setFilingDocs(trimmed);
      // Persist filing docs & signal
      const tA = tokenize(trimmed[0]?.text || "", false);
      const tB = trimmed.length >= 2 ? tokenize(trimmed[1].text, false) : [];
      const sig10k = trimmed.length >= 2 ? classifySignal(computeAllScores(tA, tB).avg) : null;
      saveTickerData(ticker, { ...data, filing: { docs: trimmed, signal10k: sig10k } });
      setData(getTickerData(ticker));
    } finally {
      setFilingLoading(false);
    }
  }

  function clearFilings() {
    setFilingDocs([]);
    setShowDiff(false);
    saveTickerData(ticker, { ...data, filing: { docs: [], signal10k: null } });
    setData(getTickerData(ticker));
  }

  const hasEvaluated = data?.factors?.length > 0;

  return (
    <div style={{maxWidth:960,margin:"0 auto",padding:"24px 20px"}}>
      {/* Back button + header */}
      <button onClick={()=>navigate("/")}
        style={{background:"transparent",border:"none",color:"#3a5a7a",cursor:"pointer",fontSize:13,padding:"0 0 16px",display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:16}}>&larr;</span> Back to Watchlist
      </button>

      {/* Ticker header */}
      <div style={{...CARD,marginBottom:20,...(sm?{background:sm.bg,borderColor:sm.border}:{})}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{color:"#3a5a7a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:6}}>
              {data?.companyName || ticker}
            </div>
            <div style={{display:"flex",alignItems:"baseline",gap:16}}>
              <span style={{fontSize:36,fontWeight:900,color:"#c8daf0",letterSpacing:1}}>{ticker}</span>
              {hasEvaluated && sm && (
                <>
                  <span style={{fontSize:36,fontWeight:900,color:sm.color}}>{composite.signal}</span>
                  <div>
                    <div style={{color:sm.color,fontSize:16,fontWeight:700}}>{composite.composite>0?"+":""}{composite.composite.toFixed(3)}</div>
                    <div style={{color:"#3a5a7a",fontSize:12}}>{composite.confidence}% confidence</div>
                  </div>
                </>
              )}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
            <button onClick={runEvaluation} disabled={loading}
              style={{background:loading?"#0c1824":"#1e3a5a",border:`1px solid ${loading?"#1a2d40":"#2a5a8a"}`,
                color:loading?"#3a5a7a":"#c8daf0",padding:"10px 24px",borderRadius:8,
                cursor:loading?"default":"pointer",fontSize:13,fontWeight:700,letterSpacing:1}}>
              {loading ? "Evaluating..." : hasEvaluated ? "Refresh" : "Evaluate"}
            </button>
            {hasEvaluated && (
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                <span style={{color:"#2a3a4a",fontSize:11}}>
                  {composite.factorCount}/{composite.totalFactors} factors &middot; Updated {formatAge(data?.lastUpdated)}
                </span>
                <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,
                  background: data?.fromCache ? "rgba(74,222,128,0.08)" : "rgba(42,107,191,0.08)",
                  border: `1px solid ${data?.fromCache ? "rgba(74,222,128,0.25)" : "rgba(42,107,191,0.25)"}`,
                  color: data?.fromCache ? "#4ade80" : "#5a8abf"}}>
                  {data?.fromCache ? "Cached" : `${data?.cacheHits || 0} cache hits / ${data?.apiCallCount || 0} API calls`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Loading progress chips */}
        {loading && progress.length > 0 && (
          <div style={{marginTop:14,display:"flex",flexWrap:"wrap",gap:8}}>
            {progress.map(p => {
              const c = FACTOR_COLOR[p.signal] || "#3a5a7a";
              return <div key={p.name} style={{background:"#080f1c",border:`1px solid ${c}44`,borderRadius:6,padding:"5px 10px",fontSize:11,color:c}}>{p.name} {p.score!=null?(p.score>0?"+":"")+p.score.toFixed(2):""}</div>;
            })}
            <div style={{background:"#080f1c",border:"1px solid #1a2d4044",borderRadius:6,padding:"5px 10px",fontSize:11,color:"#3a5a7a",animation:"pulse 1.5s infinite"}}>fetching...</div>
          </div>
        )}
        {error && <div style={{marginTop:12,padding:"10px 14px",background:"#150808",border:"1px solid #f8717144",borderRadius:8,color:"#f87171",fontSize:13}}>{error}</div>}

        {/* Composite verdict text */}
        {hasEvaluated && (
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${sm?.border||"#1a2d40"}`,color:"#3a5a7a",fontSize:12,lineHeight:1.6}}>
            {composite.signal === "BUY" && "Multiple factors aligned bullishly."}
            {composite.signal === "HOLD" && "Mixed signals across factors. No strong directional edge."}
            {composite.signal === "SELL" && "Multiple factors flagging bearish conditions."}
            {filingFactor && filingResult && (() => {
              const fs = filingResult.factorScore;
              if (Math.abs(fs) >= 0.4) {
                const dir = fs > 0 ? "non-changer (bullish)" : "strong changer (bearish)";
                return ` 10-K filing signal: ${dir} — ${(filingResult.scores.avg * 100).toFixed(0)}% similarity.`;
              }
              return "";
            })()}
          </div>
        )}
      </div>

      {/* ── FACTOR SECTIONS ── */}
      {hasEvaluated && (
        <div style={{display:"flex",flexDirection:"column",gap:20}}>

          {/* Fundamental Signals */}
          <div style={CARD}>
            <div style={{...SECTION_TITLE,marginBottom:14}}>FUNDAMENTAL SIGNALS</div>
            <div style={{display:"flex",flexDirection:"column",gap:2}}>
              {fundamentals.map(f => (
                <FactorRow key={f.name} factor={f} expanded={!!expanded[f.name]} onToggle={()=>setExpanded(e=>({...e,[f.name]:!e[f.name]}))}/>
              ))}
            </div>
          </div>

          {/* 10-K Filing Analysis */}
          <div style={CARD}>
            <div style={{...SECTION_TITLE,marginBottom:14}}>10-K FILING ANALYSIS</div>

            {filingDocs.length < 2 ? (
              <div>
                {filingDocs.length === 1 && (
                  <div style={{marginBottom:12,padding:"8px 14px",background:"#080f1c",borderRadius:8,border:"1px solid #1a2d40",color:"#5a7a9a",fontSize:12}}>
                    Uploaded: <span style={{color:"#c8daf0"}}>{filingDocs[0].name}</span> — upload one more file to compute similarity
                  </div>
                )}
                {filingDocs.length === 0 && (
                  <div style={{color:"#3a5a7a",fontSize:13,marginBottom:14,lineHeight:1.6}}>
                    No 10-K filings uploaded for {ticker}. Upload the prior year and current year 10-K to enable this signal.
                    It will be added to the composite score with 10% weight.
                  </div>
                )}
                <DropZone onFiles={handleFilingUpload} label={filingLoading ? "Processing..." : `Upload 10-K filing ${filingDocs.length + 1} of 2`}/>
              </div>
            ) : (
              <div>
                {/* Filing summary */}
                <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",marginBottom:16}}>
                  <ScoreRing value={filingResult.scores.avg} label="Avg Similarity" color={filingResult.signal10k.color} size={80}/>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                      <span style={{padding:"4px 12px",borderRadius:6,background:`${filingResult.signal10k.color}18`,border:`1px solid ${filingResult.signal10k.color}44`,color:filingResult.signal10k.color,fontSize:13,fontWeight:700}}>{filingResult.signal10k.badge}</span>
                      <span style={{color:"#c8daf0",fontSize:14,fontWeight:600}}>Factor score: {filingResult.factorScore > 0 ? "+" : ""}{filingResult.factorScore.toFixed(1)}</span>
                    </div>
                    <div style={{color:"#3a5a7a",fontSize:12,lineHeight:1.5}}>{filingResult.signal10k.plain}</div>
                  </div>
                </div>

                {/* Individual scores */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:14}}>
                  {[["Cosine",filingResult.scores.cosine],["Jaccard",filingResult.scores.jaccard],["Min-Edit",filingResult.scores.minEdit],["Simple Diff",filingResult.scores.simple]].map(([lbl,val])=>(
                    <div key={lbl} style={{background:"#060d18",borderRadius:8,padding:"10px 12px",border:"1px solid #0c1824",textAlign:"center"}}>
                      <div style={{color:"#1e3050",fontSize:10,letterSpacing:1,marginBottom:4}}>{lbl}</div>
                      <div style={{color:"#c8daf0",fontSize:16,fontWeight:700}}>{(val*100).toFixed(1)}%</div>
                    </div>
                  ))}
                </div>

                {/* Sentiment delta */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                  <div style={{background:"#060d18",borderRadius:8,padding:"8px 12px",border:"1px solid #0c1824"}}>
                    <div style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>PRIOR YEAR ({filingDocs[0].name})</div>
                    <div style={{color:"#7a9abf",fontSize:12}}>{filingResult.tokensA.toLocaleString()} tokens &middot; Neg. sentiment: {(filingResult.sentA*100).toFixed(1)}%</div>
                  </div>
                  <div style={{background:"#060d18",borderRadius:8,padding:"8px 12px",border:"1px solid #0c1824"}}>
                    <div style={{color:"#1e3050",fontSize:10,letterSpacing:1}}>CURRENT YEAR ({filingDocs[1].name})</div>
                    <div style={{color:"#7a9abf",fontSize:12}}>{filingResult.tokensB.toLocaleString()} tokens &middot; Neg. sentiment: {(filingResult.sentB*100).toFixed(1)}%</div>
                  </div>
                </div>

                {/* Diff toggle */}
                <div style={{display:"flex",gap:10}}>
                  <button onClick={()=>setShowDiff(s=>!s)}
                    style={{background:"#080f1c",border:"1px solid #1a2d40",color:"#5a7a9a",padding:"7px 16px",borderRadius:7,cursor:"pointer",fontSize:12}}>
                    {showDiff ? "Hide Diff" : "Show Word Diff"}
                  </button>
                  <button onClick={clearFilings}
                    style={{background:"#080f1c",border:"1px solid #1a2d40",color:"#3a5a7a",padding:"7px 16px",borderRadius:7,cursor:"pointer",fontSize:12}}>
                    Clear Filings
                  </button>
                </div>
                {showDiff && filingResult.diff && <div style={{marginTop:12}}><DiffViewer diff={filingResult.diff}/></div>}

                {/* Paper reference */}
                <div style={{color:"#1e3050",fontSize:11,marginTop:14,fontStyle:"italic",lineHeight:1.5}}>
                  {filingResult.signal10k.paperRef}
                </div>
              </div>
            )}
          </div>

          {/* Market Signals */}
          <div style={CARD}>
            <div style={{...SECTION_TITLE,marginBottom:14}}>MARKET SIGNALS</div>
            <div style={{display:"flex",flexDirection:"column",gap:2}}>
              {market.map(f => (
                <FactorRow key={f.name} factor={f} expanded={!!expanded[f.name]} onToggle={()=>setExpanded(e=>({...e,[f.name]:!e[f.name]}))}/>
              ))}
            </div>
          </div>

          {/* 10-K Filing in factor list (if present) */}
          {filing10k.length > 0 && (
            <div style={CARD}>
              <div style={{...SECTION_TITLE,marginBottom:14}}>10-K FACTOR IN COMPOSITE</div>
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                {filing10k.map(f => (
                  <FactorRow key={f.name} factor={f} expanded={!!expanded[f.name]} onToggle={()=>setExpanded(e=>({...e,[f.name]:!e[f.name]}))}/>
                ))}
              </div>
            </div>
          )}

          {/* Future Signals */}
          <div style={CARD}>
            <div style={{...SECTION_TITLE,marginBottom:14}}>COMING SOON</div>
            <div style={{display:"flex",flexDirection:"column",gap:2}}>
              <FuturePlaceholder name="Short Interest Level" description="Borrow cost and days-to-cover signal"/>
              <FuturePlaceholder name="Management Tone Shift" description="NLP analysis on earnings call transcripts"/>
            </div>
          </div>
        </div>
      )}

      {/* Not yet evaluated state */}
      {!hasEvaluated && !loading && (
        <div style={{...CARD,textAlign:"center",padding:"60px 32px"}}>
          <div style={{fontSize:36,marginBottom:16,opacity:0.3}}>&#9881;</div>
          <div style={{color:"#2a4060",fontSize:16,marginBottom:8}}>No evaluation data yet</div>
          <div style={{color:"#1a2840",fontSize:13,marginBottom:20}}>Click "Evaluate" above to run the 5-factor analysis for {ticker}.</div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CACHE FOOTER — Clear cache button + stats
// ══════════════════════════════════════════════════════════════════════════════

function CacheFooter() {
  const [stats, setStats] = useState(() => getCacheStats());

  function handleClear() {
    clearAllCache();
    setStats(getCacheStats());
  }

  return (
    <div style={{marginTop:36,textAlign:"center",padding:"0 20px"}}>
      <div style={{color:"#0c1624",fontSize:11,letterSpacing:1,marginBottom:12}}>
        LAZY PRICES &middot; NBER WP 25084 &middot; 5 FACTORS + 10-K SIMILARITY
      </div>
      <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <span style={{color:"#1e3050",fontSize:11}}>
          API Cache: {stats.entryCount} entries ({stats.totalSizeKB} KB)
        </span>
        {stats.entryCount > 0 && (
          <button onClick={handleClear}
            style={{background:"#0b1420",border:"1px solid #1a2d40",color:"#3a5a7a",
              padding:"5px 14px",borderRadius:6,cursor:"pointer",fontSize:11,letterSpacing:0.5}}>
            Clear Cache
          </button>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP — router + API key gate
// ══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const route = useHashRouter();

  return (
    <div style={{minHeight:"100vh",background:"#060d18",paddingBottom:80}}>
      {/* Header */}
      <div style={{background:"linear-gradient(135deg,#080f1e 0%,#0b1728 100%)",borderBottom:"1px solid #1a2d40",padding:"28px 36px 22px"}}>
        <div style={{maxWidth:960,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:11,letterSpacing:3,color:"#1e4a8a",fontWeight:700,marginBottom:8}}>
                LAZY PRICES &middot; MULTI-FACTOR ASSET EVALUATION
              </div>
              <h1 onClick={()=>navigate("/")} style={{margin:0,fontSize:24,fontWeight:800,color:"#c8daf0",letterSpacing:-0.5,cursor:"pointer"}}>
                Lazy Prices
              </h1>
            </div>
            <div style={{color:"#1e3050",fontSize:11,textAlign:"right",letterSpacing:0.5}}>
              COHEN, MALLOY &amp; NGUYEN (2018)<br/>11-FACTOR MODEL &middot; TIER 1
            </div>
          </div>
        </div>
      </div>

      {route.view === "profile" && route.ticker
        ? <AssetProfileView ticker={route.ticker} />
        : <WatchlistView />
      }

      <CacheFooter />
    </div>
  );
}
