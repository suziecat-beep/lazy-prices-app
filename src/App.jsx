import { useState, useMemo, useRef, useCallback } from "react";
import * as mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
import { evaluateTicker } from "./engine/scoring.js";
import { getApiKey, setApiKey, clearApiKey } from "./config.js";

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
// FOUR SIMILARITY MEASURES  (Cohen, Malloy & Nguyen 2018)
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
// SIGNAL CLASSIFICATION  — 5 tiers mapped to the paper's quintile findings
//
// The paper sorts all stocks into Q1–Q5 by year-over-year document similarity.
//   Q1 (biggest changers)  → SHORT  → −34 to −58 bps/month alpha (Table II)
//   Q2                     → MILD SHORT
//   Q3                     → NEUTRAL / HOLD
//   Q4                     → MILD LONG
//   Q5 (non-changers)      → LONG   → +18 to +30 bps/month alpha (Table II)
//
// The Risk Factors section in particular produces up to 188 bps/month (Table VII).
// Returns accrue gradually over 6–18 months and do NOT reverse (Figure 7).
// ══════════════════════════════════════════════════════════════════════════════
function classifySignal(avg) {
  // avg is 0–1 where 1 = identical documents
  if (avg >= 0.85) return {
    tier: 5,
    label: "Strong Long",
    badge: "LONG",
    color: "#4ade80",
    bgColor: "rgba(74,222,128,0.08)",
    borderColor: "rgba(74,222,128,0.25)",
    arrow: "▲",
    alphaRange: "+21 to +30 bps/month",
    annualized: "~+3.5% per year (risk-adjusted)",
    horizon: "Returns accrue over 6–18 months",
    action: "Buy / Hold",
    plain: "This filing is nearly identical to the prior year. The paper finds that companies which make little-to-no changes to their 10-K are associated with positive abnormal returns in subsequent months. Investors are not pricing the stability signal.",
    paperRef: "Cohen et al. (2018) Table II: Q5 (non-changers) earns +21–30 bps/month 5-factor alpha.",
  };
  if (avg >= 0.72) return {
    tier: 4,
    label: "Mild Long",
    badge: "MILD LONG",
    color: "#86efac",
    bgColor: "rgba(134,239,172,0.06)",
    borderColor: "rgba(134,239,172,0.2)",
    arrow: "↗",
    alphaRange: "+10 to +20 bps/month",
    annualized: "~+1.5% per year (risk-adjusted)",
    horizon: "Returns accrue over 6–12 months",
    action: "Mild overweight",
    plain: "Minor changes from last year's filing. The company's narrative is largely stable, which historically correlates with modestly positive future returns. Not a screaming buy, but leans positive.",
    paperRef: "Cohen et al. (2018) Table II: Q4 portfolio earns modest positive alpha.",
  };
  if (avg >= 0.58) return {
    tier: 3,
    label: "Neutral",
    badge: "NEUTRAL",
    color: "#facc15",
    bgColor: "rgba(250,204,21,0.06)",
    borderColor: "rgba(250,204,21,0.2)",
    arrow: "→",
    alphaRange: "~0 bps/month",
    annualized: "No significant alpha expected",
    horizon: "No clear directional signal",
    action: "Market-weight / Hold",
    plain: "A moderate level of change — enough to move away from last year but not a dramatic departure. Falls roughly in the middle of the paper's quintile distribution. No strong signal in either direction.",
    paperRef: "Cohen et al. (2018) Table II: Q3 portfolio is statistically indistinguishable from zero.",
  };
  if (avg >= 0.42) return {
    tier: 2,
    label: "Mild Short",
    badge: "MILD SHORT",
    color: "#fb923c",
    bgColor: "rgba(251,146,60,0.06)",
    borderColor: "rgba(251,146,60,0.2)",
    arrow: "↘",
    alphaRange: "−10 to −20 bps/month",
    annualized: "~−1.5% per year (risk-adjusted)",
    horizon: "Negative drift over 6–12 months",
    action: "Mild underweight",
    plain: "Meaningful changes in language versus last year. The paper finds this level of change is associated with negative future returns as investors gradually discover the implications of what changed — but didn't react to at the time of filing.",
    paperRef: "Cohen et al. (2018) Table II: Q2 portfolio earns modest negative alpha.",
  };
  return {
    tier: 1,
    label: "Strong Short",
    badge: "SHORT",
    color: "#f87171",
    bgColor: "rgba(248,113,113,0.08)",
    borderColor: "rgba(248,113,113,0.3)",
    arrow: "▼",
    alphaRange: "−34 to −58 bps/month",
    annualized: "~−5 to −7% per year (risk-adjusted)",
    horizon: "Negative drift over 6–18 months, no reversal",
    action: "Short / Underweight",
    plain: "Major changes from the prior year's filing — this company is in the bottom quintile of similarity (Q1). The paper's core finding is that these 'changers' experience significant negative abnormal returns over the following 6–18 months. Critically, the market does NOT react at filing time — the stock price falls slowly as news eventually confirms what the changed language hinted at.",
    paperRef: "Cohen et al. (2018) Table II: Q1 (strong changers) earns −34 to −58 bps/month 5-factor alpha. Returns continue accruing to 18 months with no reversal (Figure 7).",
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SAMPLE DOCS
// ══════════════════════════════════════════════════════════════════════════════
const SAMPLE_DOCS = [
  { id:"s1", name:"Baxter_2008_10K.txt", text:`With respect to COLLEAGUE, the company remains in active dialogue with the FDA about various matters, including the company's remediation plan and reviews of the Company's facilities, processes and quality controls by the company's outside expert pursuant to the requirements of the company's Consent Decree. The outcome of these discussions with the FDA is uncertain and may impact the nature and timing of the company's actions and decisions with respect to the COLLEAGUE pump. The company's estimates of the costs related to these matters are based on the current remediation plan and information currently available. It is possible that additional charges related to COLLEAGUE may be required in future periods, based on new information, changes in estimates, and modifications to the current remediation plan as a result of ongoing dialogue with the FDA. In addition, the healthcare regulatory environment may change in way that restricts our existing operations or our growth. Failure to provide quality products and services to our customers could have an adverse effect on our business and subject us to regulatory actions and costly litigation.` },
  { id:"s2", name:"Baxter_2009_10K.txt", text:`The company remains in active dialogue with the FDA regarding various matters with respect to the company's COLLEAGUE infusion pumps, including the company's remediation plan and reviews of the company's facilities, processes and quality controls by the company's outside expert pursuant to the requirements of the company's Consent Decree. The outcome of these discussions with the FDA is uncertain and may impact the nature and timing of the company's actions and decisions with respect to the COLLEAGUE pump. It is possible that substantial additional charges, including significant asset impairments, related to COLLEAGUE may be required in future periods, based on new information, changes in estimates, and modifications to the current remediation plan. The sales and marketing of our products and our relationships with healthcare providers are under increasing scrutiny by federal, state and foreign government agencies. The FDA, the OIG, the Department of Justice and the Federal Trade Commission have each increased their enforcement efforts with respect to the anti-kickback statute, False Claims Act, off-label promotion of products and other healthcare related laws. Issues with product quality could have an adverse effect on our business and subject us to regulatory actions and costly litigation.` },
  { id:"s3", name:"Herbalife_2013_10K.txt", text:`From time to time, we receive inquiries from various government authorities requesting information from the Company. Following December 2012 market events and a subsequent meeting we requested with the staff of the SEC's Division of Enforcement, the staff requested information regarding the Company's business and financial operations. Consistent with its policies, the Company is and will fully cooperate with these inquiries. Our stock price may be affected by speculative trading, including those shorting our stock. In late 2012, a hedge fund manager publicly raised allegations regarding the legality of our network marketing program and announced that his fund had taken a significant short position regarding our common shares, leading to intense public scrutiny and significant stock price volatility. Our stock price has continued to exhibit heightened volatility.` },
  { id:"s4", name:"Herbalife_2014_10K.txt", text:`From time to time, the Company is subject to inquiries from and investigations by various governmental and other regulatory authorities with respect to the legality of the Company's network marketing program. To the extent any of these inquiries are or become material they will be disclosed as required by applicable securities laws. The Company believes it could receive additional inquiries. Our stock price may be adversely affected by third parties who raise allegations about our Company. Short sellers and others who raise allegations regarding the legality of our business activities, some of whom are positioned to profit if our stock declines, can negatively affect our stock price. This hedge fund manager continues to make allegations regarding the legality of our network marketing program, our product safety, our accounting practices and other matters. Additionally, from time to time the Company is subject to governmental and regulatory inquiries and inquiries from legislators that may adversely affect our stock price.` },
];

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL CARD  — the main new component, shown prominently in DetailPanel
// ══════════════════════════════════════════════════════════════════════════════
function SignalCard({ sig, avgSim }) {
  const tiers = [1,2,3,4,5];
  return (
    <div style={{
      background: sig.bgColor,
      border: `2px solid ${sig.borderColor}`,
      borderRadius: 14,
      padding: "24px 28px",
      marginBottom: 24,
    }}>
      {/* Top row: badge + score */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:16, marginBottom:20 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
            <div style={{
              background: sig.color,
              color: "#060d18",
              padding: "6px 18px",
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: 1.5,
            }}>{sig.badge}</div>
            <span style={{ color: sig.color, fontSize: 22, fontWeight: 800 }}>{sig.arrow} {sig.label}</span>
          </div>
          <div style={{ color: sig.color, fontSize: 26, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>
            {(avgSim * 100).toFixed(1)}% Similar
          </div>
          <div style={{ color: "#6a8aaa", fontSize: 13 }}>
            Average of 4 similarity measures
          </div>
        </div>

        {/* Quintile tier indicator */}
        <div style={{ textAlign:"right" }}>
          <div style={{ color:"#3a5a7a", fontSize:11, letterSpacing:1, marginBottom:8, textTransform:"uppercase" }}>
            Quintile (Paper)
          </div>
          <div style={{ display:"flex", gap:5 }}>
            {tiers.map(t => (
              <div key={t} style={{
                width: 36, height: 36, borderRadius: 8,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontWeight: 700, fontSize: 15,
                background: t === sig.tier ? sig.color : "#0f1e30",
                color: t === sig.tier ? "#060d18" : "#2a4060",
                border: `1px solid ${t === sig.tier ? sig.color : "#1a2d40"}`,
                transition: "all 0.3s",
              }}>Q{t}</div>
            ))}
          </div>
          <div style={{ color:"#2a4060", fontSize:10, marginTop:6 }}>Q1=Short · Q5=Long</div>
        </div>
      </div>

      {/* What this means in plain English */}
      <div style={{
        background:"rgba(0,0,0,0.25)",
        borderRadius:10,
        padding:"16px 20px",
        marginBottom:16,
        borderLeft:`3px solid ${sig.color}`,
      }}>
        <div style={{ color:"#8ab4d4", fontSize:12, letterSpacing:1, fontWeight:700, marginBottom:8, textTransform:"uppercase" }}>
          What this means
        </div>
        <p style={{ color:"#c8daf0", fontSize:14, lineHeight:1.75, margin:0 }}>
          {sig.plain}
        </p>
      </div>

      {/* Three stat boxes */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:16 }}>
        {[
          { label:"Expected Alpha", value:sig.alphaRange, icon:"📈" },
          { label:"Annualized (approx)", value:sig.annualized, icon:"📅" },
          { label:"Return Horizon", value:sig.horizon, icon:"⏳" },
        ].map(s=>(
          <div key={s.label} style={{
            background:"rgba(0,0,0,0.3)",
            borderRadius:10,
            padding:"14px 16px",
            border:`1px solid ${sig.borderColor}`,
          }}>
            <div style={{ fontSize:20, marginBottom:6 }}>{s.icon}</div>
            <div style={{ color:"#3a5a7a", fontSize:11, letterSpacing:0.8, textTransform:"uppercase", marginBottom:4 }}>{s.label}</div>
            <div style={{ color: sig.color, fontSize:13, fontWeight:700, lineHeight:1.4 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Recommended action */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <div style={{
          display:"flex", alignItems:"center", gap:10,
          background:"rgba(0,0,0,0.3)", borderRadius:8, padding:"10px 16px",
          border:`1px solid ${sig.borderColor}`,
        }}>
          <span style={{ color:"#3a5a7a", fontSize:12 }}>Suggested action:</span>
          <span style={{ color:sig.color, fontSize:14, fontWeight:700 }}>{sig.action}</span>
        </div>
        <div style={{ color:"#2a4060", fontSize:11, fontStyle:"italic", maxWidth:400, lineHeight:1.5 }}>
          ⚠ {sig.paperRef}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SCORE RING
// ══════════════════════════════════════════════════════════════════════════════
function ScoreRing({ value, label, color, size=88 }) {
  const r=size*0.41, cx=size/2, cy=size/2, circ=2*Math.PI*r;
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
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
      <span style={{color:"#5a7a9a",fontSize:12,letterSpacing:1,textTransform:"uppercase"}}>
        {label}
      </span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DIFF VIEWER
// ══════════════════════════════════════════════════════════════════════════════
function DiffViewer({ diff }) {
  return (
    <div style={{
      fontSize:13, lineHeight:2, background:"#060d18", borderRadius:10,
      padding:"18px 20px", maxHeight:260, overflowY:"auto",
      wordBreak:"break-word", border:"1px solid #1a2d40",
    }}>
      {diff.map((op,i)=>{
        if(op.type==="same") return <span key={i} style={{color:"#2a4060"}}>{op.word} </span>;
        if(op.type==="add")  return <span key={i} style={{color:"#4ade80",background:"rgba(74,222,128,0.08)",borderRadius:4,padding:"1px 4px",marginRight:3}}>+{op.word} </span>;
        return <span key={i} style={{color:"#f87171",background:"rgba(248,113,113,0.08)",borderRadius:4,padding:"1px 4px",marginRight:3,textDecoration:"line-through",opacity:.75}}>-{op.word} </span>;
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DROP ZONE
// ══════════════════════════════════════════════════════════════════════════════
function DropZone({ onFiles }) {
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
      style={{
        border:`2px dashed ${drag?"#2a6bbf":"#1e3050"}`, borderRadius:12, padding:"28px 20px",
        textAlign:"center", cursor:"pointer",
        background:drag?"rgba(42,107,191,0.06)":"#080f1c", transition:"all 0.2s",
      }}>
      <input ref={ref} type="file" multiple accept=".txt,.pdf,.docx,.csv" style={{display:"none"}} onChange={e=>handle(e.target.files)}/>
      <div style={{fontSize:28,marginBottom:10}}>📂</div>
      <div style={{color:"#4a7aaa",fontSize:14,fontWeight:600,marginBottom:4}}>Drop files or click to browse</div>
      <div style={{color:"#1e3050",fontSize:12}}>Accepts .txt · .pdf · .docx · .csv</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DOC CHIP
// ══════════════════════════════════════════════════════════════════════════════
function DocChip({ doc, selected, onClick, onRemove, isLoading, hasError }) {
  const ext = doc.name.split(".").pop().toLowerCase();
  const extColors = {txt:"#2a6bbf",pdf:"#f87171",docx:"#7c3aed",csv:"#059669"};
  const ec = extColors[ext]||"#4a6a8a";
  return (
    <div onClick={onClick} style={{
      display:"flex", alignItems:"center", gap:10, padding:"10px 14px",
      borderRadius:9, cursor:"pointer",
      background:selected?"#0f1f35":"#080f1c",
      border:`1px solid ${selected?"#2a6bbf55":hasError?"#f8717144":"#1a2d40"}`,
      transition:"all 0.15s",
    }}>
      <div style={{
        width:9, height:9, borderRadius:"50%", flexShrink:0,
        background:isLoading?"#facc15":hasError?"#f87171":selected?"#2a6bbf":ec,
        animation:isLoading?"pulse 1s infinite":"none",
      }}/>
      <span style={{color:hasError?"#f87171":"#7a9abf",fontSize:13,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>
        {doc.name}
      </span>
      <span style={{color:ec,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>.{ext}</span>
      {onRemove&&(<span onClick={e=>{e.stopPropagation();onRemove();}} style={{color:"#2a4060",fontSize:14,cursor:"pointer",padding:"0 3px",borderRadius:4}}>✕</span>)}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MATRIX CELL
// ══════════════════════════════════════════════════════════════════════════════
function MatrixCell({ scores, onClick, diagonal }) {
  if(diagonal) return <div style={{background:"#040a12",borderRadius:6,height:"100%",display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{color:"#0f1e2e",fontSize:12}}>—</span></div>;
  if(!scores)  return <div style={{background:"#080f1c",borderRadius:6}}/>;
  const sig = classifySignal(scores.avg);
  return (
    <div onClick={onClick} style={{
      background:"#080f1c", borderRadius:6, padding:"8px 10px", cursor:"pointer",
      border:`1px solid ${sig.color}33`, transition:"all 0.15s",
      display:"flex", flexDirection:"column", gap:5,
    }}>
      <div style={{color:sig.color,fontSize:14,fontWeight:700}}>{Math.round(scores.avg*100)}%</div>
      <div style={{height:3,background:"#1a2840",borderRadius:2}}>
        <div style={{height:"100%",borderRadius:2,background:sig.color,width:`${scores.avg*100}%`,transition:"width 0.5s"}}/>
      </div>
      <div style={{color:sig.color,fontSize:10,fontWeight:600,letterSpacing:0.5}}>{sig.badge}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// BATCH TABLE
// ══════════════════════════════════════════════════════════════════════════════
function BatchTable({ pairs, docs, onSelect }) {
  const [sortKey, setSortKey] = useState("avg");
  const sorted = [...pairs].sort((a,b)=>a.scores[sortKey]-b.scores[sortKey]);
  const TH = ({col,label}) => (
    <th onClick={()=>setSortKey(col)} style={{
      padding:"10px 14px",textAlign:"right",cursor:"pointer",userSelect:"none",
      color:sortKey===col?"#2a6bbf":"#2a4060",fontSize:12,letterSpacing:1,
      fontWeight:700,textTransform:"uppercase",whiteSpace:"nowrap",
    }}>{label}{sortKey===col?" ↑":""}</th>
  );
  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
        <thead>
          <tr style={{borderBottom:"1px solid #1a2d40"}}>
            <th style={{padding:"10px 14px",textAlign:"left",color:"#2a4060",fontSize:12,letterSpacing:1,fontWeight:700}}>PAIR</th>
            <TH col="cosine"  label="Cosine"/>
            <TH col="jaccard" label="Jaccard"/>
            <TH col="minEdit" label="MinEdit"/>
            <TH col="simple"  label="Diff"/>
            <TH col="avg"     label="Avg"/>
            <th style={{padding:"10px 14px",textAlign:"center",color:"#2a4060",fontSize:12,letterSpacing:1,fontWeight:700}}>SIGNAL</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p,i)=>{
            const sig=classifySignal(p.scores.avg);
            const dA=docs.find(d=>d.id===p.a), dB=docs.find(d=>d.id===p.b);
            return (
              <tr key={i} onClick={()=>onSelect(p.a,p.b)}
                style={{borderBottom:"1px solid #0c1824",cursor:"pointer",background:i%2===0?"transparent":"rgba(8,15,28,0.4)"}}>
                <td style={{padding:"12px 14px",maxWidth:260}}>
                  <div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>
                    <span style={{color:"#3a5a7a"}}>{dA?.name||p.a}</span>
                    <span style={{color:"#1a2d40",margin:"0 8px"}}>↔</span>
                    <span style={{color:"#3a5a7a"}}>{dB?.name||p.b}</span>
                  </div>
                </td>
                {["cosine","jaccard","minEdit","simple","avg"].map(k=>(
                  <td key={k} style={{padding:"12px 14px",textAlign:"right",color:k==="avg"?sig.color:"#3a5a7a",fontWeight:k==="avg"?700:400}}>
                    {(p.scores[k]*100).toFixed(1)}%
                  </td>
                ))}
                <td style={{padding:"12px 14px",textAlign:"center"}}>
                  <span style={{background:sig.bgColor,color:sig.color,border:`1px solid ${sig.borderColor}`,
                    padding:"4px 10px",borderRadius:6,fontSize:11,letterSpacing:0.5,fontWeight:700,whiteSpace:"nowrap"}}>
                    {sig.arrow} {sig.badge}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DETAIL PANEL
// ══════════════════════════════════════════════════════════════════════════════
function DetailPanel({ docA, docB, stopWords, onClose }) {
  const tA   = useMemo(()=>tokenize(docA.text,stopWords),[docA,stopWords]);
  const tB   = useMemo(()=>tokenize(docB.text,stopWords),[docB,stopWords]);
  const sc   = useMemo(()=>computeAllScores(tA,tB),[tA,tB]);
  const diff = useMemo(()=>computeDiff(tA,tB),[tA,tB]);
  const sig  = classifySignal(sc.avg);
  const sentA=sentimentScore(tA), sentB=sentimentScore(tB), sentDelta=sentB-sentA;
  const added=diff.filter(d=>d.type==="add").length, deld=diff.filter(d=>d.type==="del").length;
  const [tab, setTab] = useState("signal");

  return (
    <div className="fade-in" style={{background:"#0a1628",border:"1px solid #1a2d40",borderRadius:14,padding:"24px 28px",marginTop:16}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
            <span style={{color:"#3a6a9a",fontSize:13,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{docA.name}</span>
            <span style={{color:"#1a2d40",fontSize:16}}>↔</span>
            <span style={{color:"#3a6a9a",fontSize:13,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{docB.name}</span>
          </div>
          <div style={{color:"#2a4060",fontSize:12}}>Click a tab below to explore the analysis</div>
        </div>
        {onClose&&(
          <button onClick={onClose} style={{background:"transparent",border:"1px solid #1a2d40",color:"#3a5a7a",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:13}}>
            ✕ Close
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:20,borderBottom:"1px solid #1a2d40",paddingBottom:0}}>
        {[["signal","📊 Signal"],["scores","🔢 Scores"],["diff","📝 Diff"],["stats","📈 Stats"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{
            padding:"10px 18px",borderRadius:"8px 8px 0 0",border:"none",cursor:"pointer",
            fontSize:13,fontWeight:600,
            background:tab===id?"#162033":"transparent",
            color:tab===id?"#c8daf0":"#2a4060",
            borderBottom:tab===id?"2px solid #2a6bbf":"2px solid transparent",
            marginBottom:"-1px",
          }}>{label}</button>
        ))}
      </div>

      {/* Signal tab — shown by default */}
      {tab==="signal" && (
        <div>
          <SignalCard sig={sig} avgSim={sc.avg}/>
          {/* Quick numbers row */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
            {[
              {l:"Cosine",v:sc.cosine,c:"#2a6bbf"},
              {l:"Jaccard",v:sc.jaccard,c:"#7c3aed"},
              {l:"Min Edit",v:sc.minEdit,c:"#0891b2"},
              {l:"Diff",v:sc.simple,c:"#059669"},
            ].map(m=>(
              <div key={m.l} style={{background:"#060d18",borderRadius:10,padding:"14px 16px",border:`1px solid ${m.c}22`,textAlign:"center"}}>
                <div style={{color:m.c,fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>{m.l}</div>
                <div style={{color:"#c8daf0",fontSize:20,fontWeight:800}}>{(m.v*100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scores tab */}
      {tab==="scores" && (
        <div>
          <div style={{display:"flex",justifyContent:"space-around",flexWrap:"wrap",gap:16,marginBottom:24}}>
            <ScoreRing value={sc.cosine}  label="Cosine"  color="#2a6bbf"/>
            <ScoreRing value={sc.jaccard} label="Jaccard" color="#7c3aed"/>
            <ScoreRing value={sc.minEdit} label="Min Edit" color="#0891b2"/>
            <ScoreRing value={sc.simple}  label="Diff"    color="#059669"/>
            <ScoreRing value={sc.avg}     label="Average" color={sig.color} size={100}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {[
              {k:"cosine",c:"#2a6bbf",name:"Cosine Similarity",d:"Builds a term-frequency vector for each document. A high cosine score means the two filings use the same words at similar rates — the vocabulary and emphasis are consistent year-over-year."},
              {k:"jaccard",c:"#7c3aed",name:"Jaccard Similarity",d:"Treats each filing as a set of unique words. Measures how much vocabulary they share, ignoring frequency. Sensitive to new topics being introduced or old ones dropped entirely."},
              {k:"minEdit",c:"#0891b2",name:"Min Edit Distance",d:"Counts the fewest word insertions and deletions needed to turn one filing into the other. Low scores mean the documents require major surgery to reconcile — lots changed."},
              {k:"simple",c:"#059669",name:"Simple Diff",d:"Replicates Microsoft Word's Track Changes / Unix diff. Counts changed words as a fraction of average document length. This is the most intuitive measure of raw editing activity."},
            ].map(m=>(
              <div key={m.k} style={{background:"#060d18",borderRadius:10,padding:"16px 18px",border:`1px solid ${m.c}22`}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{color:m.c,fontSize:13,fontWeight:700}}>{m.name}</span>
                  <span style={{color:"#c8daf0",fontSize:16,fontWeight:800}}>{(sc[m.k]*100).toFixed(1)}%</span>
                </div>
                <div style={{height:3,background:"#1a2840",borderRadius:2,marginBottom:10}}>
                  <div style={{height:"100%",borderRadius:2,background:m.c,width:`${sc[m.k]*100}%`,transition:"width 0.6s"}}/>
                </div>
                <p style={{color:"#3a5a7a",fontSize:12,margin:0,lineHeight:1.6}}>{m.d}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Diff tab */}
      {tab==="diff" && (
        <div>
          <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
            {[
              {l:"Words Added",v:added,c:"#4ade80"},
              {l:"Words Removed",v:deld,c:"#f87171"},
              {l:"Unchanged",v:diff.filter(d=>d.type==="same").length,c:"#3a5a7a"},
              {l:"Change Rate",v:`${((added+deld)/Math.max(1,diff.length)*100).toFixed(1)}%`,c:"#facc15"},
            ].map(s=>(
              <div key={s.l} style={{background:"#060d18",borderRadius:8,padding:"12px 16px",border:`1px solid ${s.c}22`,flex:1,minWidth:100}}>
                <div style={{color:s.c,fontSize:18,fontWeight:800,marginBottom:3}}>{s.v}</div>
                <div style={{color:"#2a4060",fontSize:11,letterSpacing:0.5}}>{s.l.toUpperCase()}</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:16,marginBottom:10}}>
            <span style={{color:"#4ade80",fontSize:12}}>● Added</span>
            <span style={{color:"#f87171",fontSize:12}}>● Removed</span>
            <span style={{color:"#2a4060",fontSize:12}}>● Unchanged</span>
          </div>
          <DiffViewer diff={diff}/>
          <p style={{color:"#1e3050",fontSize:11,marginTop:8,textAlign:"right"}}>Showing first 400 tokens · LCS algorithm (equivalent to Unix diff)</p>
        </div>
      )}

      {/* Stats tab */}
      {tab==="stats" && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
          <div>
            <div style={{color:"#2a6bbf",fontSize:12,letterSpacing:1,fontWeight:700,marginBottom:14,textTransform:"uppercase"}}>Document Metrics</div>
            {[
              {l:"Doc A token count",v:tA.length,max:Math.max(tA.length,tB.length),c:"#2a6bbf"},
              {l:"Doc B token count",v:tB.length,max:Math.max(tA.length,tB.length),c:"#7c3aed"},
              {l:"Words added",v:added,max:Math.max(tB.length,1),c:"#4ade80"},
              {l:"Words removed",v:deld,max:Math.max(tA.length,1),c:"#f87171"},
            ].map(s=>(
              <div key={s.l} style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span style={{color:"#3a5a7a",fontSize:13}}>{s.l}</span>
                  <span style={{color:"#8ab4d4",fontSize:13,fontWeight:700}}>{s.v.toLocaleString()}</span>
                </div>
                <div style={{height:4,background:"#1a2840",borderRadius:2}}>
                  <div style={{height:"100%",borderRadius:2,background:s.c,width:`${Math.min(100,(s.v/s.max)*100)}%`,transition:"width 0.5s"}}/>
                </div>
              </div>
            ))}
          </div>
          <div>
            <div style={{color:"#059669",fontSize:12,letterSpacing:1,fontWeight:700,marginBottom:14,textTransform:"uppercase"}}>Sentiment (Loughran-McDonald)</div>
            {[
              {l:"Doc A — negative word %",v:sentA,c:"#2a6bbf"},
              {l:"Doc B — negative word %",v:sentB,c:"#7c3aed"},
            ].map(s=>(
              <div key={s.l} style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span style={{color:"#3a5a7a",fontSize:13}}>{s.l}</span>
                  <span style={{color:"#8ab4d4",fontSize:13,fontWeight:700}}>{(s.v*100).toFixed(2)}%</span>
                </div>
                <div style={{height:4,background:"#1a2840",borderRadius:2}}>
                  <div style={{height:"100%",borderRadius:2,background:s.c,width:`${Math.min(100,s.v*2000)}%`,transition:"width 0.5s"}}/>
                </div>
              </div>
            ))}
            <div style={{background:"#060d18",borderRadius:10,padding:"16px 18px",marginTop:8,
              border:`1px solid ${sentDelta>0?"#f87171":"#4ade80"}22`}}>
              <div style={{color:"#3a5a7a",fontSize:12,marginBottom:6}}>SENTIMENT DELTA (Doc B − Doc A)</div>
              <div style={{color:sentDelta>0?"#f87171":"#4ade80",fontSize:22,fontWeight:800}}>
                {sentDelta>=0?"+":""}{(sentDelta*100).toFixed(2)}%
              </div>
              <div style={{color:"#2a4060",fontSize:12,marginTop:6,lineHeight:1.6}}>
                {sentDelta>0.005
                  ? "↑ Rising negative sentiment — the paper finds 86% of meaningful changes carry negative language. This is consistent with a short signal."
                  : sentDelta<-0.005
                  ? "↓ Falling negative sentiment — language is getting more positive year-over-year."
                  : "Sentiment is stable across the two filings."}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TICKER EVALUATOR — Tier 1 asset evaluation model UI
// ══════════════════════════════════════════════════════════════════════════════

const SIGNAL_META = {
  BUY:  { color: "#4ade80", bg: "rgba(74,222,128,0.08)",  border: "rgba(74,222,128,0.3)",  label: "BUY"  },
  HOLD: { color: "#facc15", bg: "rgba(250,204,21,0.06)",  border: "rgba(250,204,21,0.25)", label: "HOLD" },
  SELL: { color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.3)", label: "SELL" },
};

const FACTOR_SIGNAL_COLOR = { BULLISH: "#4ade80", BEARISH: "#f87171", NEUTRAL: "#facc15", ERROR: "#3a5a7a" };

function ScoreBar({ score }) {
  if (score === null || score === undefined) return <span style={{color:"#3a5a7a",fontSize:11}}>N/A</span>;
  const pct = Math.round((score + 1) / 2 * 100); // map -1..+1 to 0..100%
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

function FactorDetailPanel({ factor }) {
  const d = factor.details || {};
  const cardStyle = {background:"#060d18",border:"1px solid #0c1824",borderRadius:8,padding:"14px 16px",marginTop:8};
  const labelStyle = {color:"#3a5a7a",fontSize:11,letterSpacing:1,fontWeight:700};
  const valStyle = {color:"#7a9abf",fontSize:12};

  if (d.error) return (
    <div style={cardStyle}><span style={{color:"#f87171",fontSize:12}}>{d.error}</span></div>
  );

  // Earnings Growth Trajectory
  if (d.quarters && d.trajectory !== undefined && d.yoy_eps_growth_pct !== undefined) {
    return (
      <div style={cardStyle}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
          <div><div style={labelStyle}>TRAJECTORY</div><div style={{...valStyle,color:"#c8daf0"}}>{d.trajectory?.replace(/_/g," ")}</div></div>
          <div><div style={labelStyle}>YOY EPS GROWTH</div><div style={{...valStyle,color: (d.yoy_eps_growth_pct ?? 0) >= 0 ? "#4ade80":"#f87171"}}>{d.yoy_eps_growth_pct !== null ? ((d.yoy_eps_growth_pct > 0 ? "+" : "") + d.yoy_eps_growth_pct?.toFixed(2) + "%") : "N/A"}</div></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:8}}>
          {d.quarters?.map((q,i)=>(
            <div key={i} style={{background:"#080f1c",borderRadius:6,padding:"8px 10px",border:"1px solid #0c1824"}}>
              <div style={{color:"#1e3050",fontSize:10,marginBottom:4}}>{q.date}</div>
              <div style={{color:"#7a9abf",fontSize:11}}>EPS: <span style={{color:"#c8daf0"}}>${q.eps?.toFixed(2)}</span></div>
              <div style={{color:"#7a9abf",fontSize:11}}>Revenue: <span style={{color:"#c8daf0"}}>${(q.revenue/1e9).toFixed(1)}B</span></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Revenue Growth
  if (d.trend !== undefined && (d.latest_yoy_pct !== undefined || d.latest_qoq_pct !== undefined)) {
    return (
      <div style={cardStyle}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
          <div><div style={labelStyle}>TREND</div><div style={{...valStyle,color:"#c8daf0"}}>{d.trend}</div></div>
          {d.latest_yoy_pct !== null && <div><div style={labelStyle}>LATEST YOY</div><div style={{...valStyle,color: d.latest_yoy_pct >= 0 ? "#4ade80":"#f87171"}}>{d.latest_yoy_pct > 0 ? "+" : ""}{d.latest_yoy_pct?.toFixed(1)}%</div></div>}
          {d.latest_qoq_pct !== null && <div><div style={labelStyle}>LATEST QOQ</div><div style={{...valStyle,color: d.latest_qoq_pct >= 0 ? "#4ade80":"#f87171"}}>{d.latest_qoq_pct > 0 ? "+" : ""}{d.latest_qoq_pct?.toFixed(1)}%</div></div>}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {d.quarters?.map((q,i)=>(
            <div key={i} style={{background:"#080f1c",borderRadius:6,padding:"8px 10px",border:"1px solid #0c1824",minWidth:130}}>
              <div style={{color:"#1e3050",fontSize:10,marginBottom:4}}>{q.date}</div>
              <div style={{color:"#7a9abf",fontSize:11}}>Rev: <span style={{color:"#c8daf0"}}>${(q.revenue/1e9).toFixed(1)}B</span></div>
              {q.qoq_growth_pct !== null && <div style={{color: q.qoq_growth_pct >= 0 ? "#4ade80":"#f87171",fontSize:11}}>QoQ: {q.qoq_growth_pct > 0 ? "+" : ""}{q.qoq_growth_pct?.toFixed(1)}%</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Gross Margin (has slope_pp_per_quarter)
  if (d.slope_pp_per_quarter !== undefined) {
    return (
      <div style={cardStyle}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
          <div><div style={labelStyle}>TREND</div><div style={{...valStyle,color:"#c8daf0"}}>{d.trend}</div></div>
          <div><div style={labelStyle}>MARGIN CHANGE</div><div style={{...valStyle,color: d.margin_change_pp >= 0 ? "#4ade80":"#f87171"}}>{d.margin_change_pp > 0 ? "+" : ""}{d.margin_change_pp?.toFixed(2)}pp</div></div>
          <div><div style={labelStyle}>VOLATILITY</div><div style={{...valStyle,color: d.is_volatile ? "#fb923c":"#7a9abf"}}>{d.volatility?.toFixed(2)}pp {d.is_volatile ? "⚠ volatile":""}</div></div>
          <div><div style={labelStyle}>RECENT AVG</div><div style={valStyle}>{d.avg_recent_margin_pct?.toFixed(1)}%</div></div>
          <div><div style={labelStyle}>PRIOR AVG</div><div style={valStyle}>{d.avg_prior_margin_pct?.toFixed(1)}%</div></div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {d.quarters?.map((q,i)=>(
            <div key={i} style={{background:"#080f1c",borderRadius:6,padding:"8px 10px",border:"1px solid #0c1824",minWidth:120}}>
              <div style={{color:"#1e3050",fontSize:10,marginBottom:4}}>{q.date}</div>
              <div style={{color:"#c8daf0",fontSize:12,fontWeight:600}}>{q.gross_margin_pct?.toFixed(1)}%</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Accruals Ratio
  if (d.accruals_ratio !== undefined) {
    const fmt = (n) => n != null ? (n > 0 ? "+" : "") + n.toFixed(4) : "N/A";
    return (
      <div style={cardStyle}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          <div><div style={labelStyle}>NET INCOME</div><div style={valStyle}>${(d.net_income/1e9).toFixed(2)}B</div></div>
          <div><div style={labelStyle}>OPER. CASH FLOW</div><div style={valStyle}>${(d.operating_cash_flow/1e9).toFixed(2)}B</div></div>
          <div><div style={labelStyle}>TOTAL ASSETS</div><div style={valStyle}>${(d.total_assets/1e9).toFixed(1)}B</div></div>
          <div><div style={labelStyle}>ACCRUALS</div><div style={{...valStyle,color: d.accruals < 0 ? "#4ade80":"#f87171"}}>${(d.accruals/1e9).toFixed(2)}B</div></div>
          <div><div style={labelStyle}>ACCRUALS RATIO</div><div style={{...valStyle,color: d.accruals_ratio < 0 ? "#4ade80":"#f87171",fontWeight:600}}>{fmt(d.accruals_ratio)}</div></div>
          {d.accruals_change !== null && <div><div style={labelStyle}>YOY CHANGE</div><div style={{...valStyle,color: d.accruals_change <= 0 ? "#4ade80":"#f87171"}}>{fmt(d.accruals_change)}</div></div>}
        </div>
      </div>
    );
  }

  // Price Momentum
  if (d.momentum_return_pct !== undefined) {
    return (
      <div style={cardStyle}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          <div><div style={labelStyle}>PRICE 12M AGO</div><div style={valStyle}>${d.price_12m_ago} <span style={{fontSize:10,color:"#1e3050"}}>({d.date_12m_ago})</span></div></div>
          <div><div style={labelStyle}>PRICE 1M AGO</div><div style={valStyle}>${d.price_1m_ago} <span style={{fontSize:10,color:"#1e3050"}}>({d.date_1m_ago})</span></div></div>
          <div><div style={labelStyle}>PRICE TODAY</div><div style={valStyle}>${d.price_current}</div></div>
          <div><div style={labelStyle}>12-1 MOMENTUM</div><div style={{...valStyle,color: d.momentum_return_pct >= 0 ? "#4ade80":"#f87171",fontWeight:700,fontSize:14}}>{d.momentum_return_pct > 0 ? "+" : ""}{d.momentum_return_pct?.toFixed(2)}%</div></div>
          <div><div style={labelStyle}>RECENT 1M</div><div style={{...valStyle,color: d.recent_1m_return_pct >= 0 ? "#4ade80":"#f87171"}}>{d.recent_1m_return_pct > 0 ? "+" : ""}{d.recent_1m_return_pct?.toFixed(2)}%</div></div>
        </div>
      </div>
    );
  }

  return <div style={cardStyle}><pre style={{color:"#3a5a7a",fontSize:11,margin:0,whiteSpace:"pre-wrap"}}>{JSON.stringify(d,null,2)}</pre></div>;
}

function TickerEvaluator() {
  const [apiKey, setApiKeyState]       = useState(() => getApiKey());
  const [apiKeyInput, setApiKeyInput]  = useState("");
  const [ticker, setTicker]            = useState("");
  const [loading, setLoading]          = useState(false);
  const [progress, setProgress]        = useState([]);
  const [result, setResult]            = useState(null);
  const [error, setError]              = useState(null);
  const [expanded, setExpanded]        = useState({});

  const card = {background:"#0b1420",borderRadius:12,padding:"20px 22px",border:"1px solid #1a2d40"};

  function saveApiKey() {
    const k = apiKeyInput.trim();
    if (!k) return;
    setApiKey(k);
    setApiKeyState(k);
    setApiKeyInput("");
  }

  async function runEvaluation() {
    if (!ticker.trim() || !apiKey) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress([]);
    setExpanded({});
    try {
      const res = await evaluateTicker(ticker.trim(), apiKey, (name, factorResult) => {
        setProgress((p) => [...p, { name, signal: factorResult.signal, score: factorResult.score }]);
      });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleExpand(name) {
    setExpanded((e) => ({ ...e, [name]: !e[name] }));
  }

  const sm = result ? SIGNAL_META[result.signal] : null;

  if (!apiKey) {
    return (
      <div style={card}>
        <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:16}}>FMP API KEY REQUIRED</div>
        <p style={{color:"#3a5a7a",fontSize:13,marginTop:0,marginBottom:16,lineHeight:1.6}}>
          This feature uses the Financial Modeling Prep API to fetch live financial data.
          Get a free key (250 calls/day) at{" "}
          <span style={{color:"#2a6bbf"}}>financialmodelingprep.com</span>.
          Your key is stored only in your browser's localStorage.
        </p>
        <div style={{display:"flex",gap:10}}>
          <input
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveApiKey()}
            placeholder="Paste your FMP API key here..."
            style={{flex:1,background:"#080f1c",border:"1px solid #1a2d40",color:"#c8daf0",
              padding:"10px 14px",borderRadius:8,fontSize:13,outline:"none"}}
          />
          <button onClick={saveApiKey} disabled={!apiKeyInput.trim()} style={{
            background:"#1e3a5a",border:"none",color:"#c8daf0",padding:"10px 20px",
            borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,
            opacity:apiKeyInput.trim() ? 1 : 0.4,
          }}>Save Key</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Ticker input */}
      <div style={card}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && !loading && runEvaluation()}
            placeholder="Enter ticker symbol (e.g. AAPL)"
            style={{flex:1,background:"#080f1c",border:"1px solid #1a2d40",color:"#c8daf0",
              padding:"12px 16px",borderRadius:8,fontSize:15,outline:"none",letterSpacing:1}}
          />
          <button onClick={runEvaluation} disabled={loading || !ticker.trim()} style={{
            background: loading ? "#0c1824" : "#1e3a5a",
            border:`1px solid ${loading ? "#1a2d40":"#2a5a8a"}`,
            color: loading ? "#3a5a7a":"#c8daf0",
            padding:"12px 28px",borderRadius:8,cursor: loading ? "default":"pointer",
            fontSize:14,fontWeight:700,letterSpacing:1,whiteSpace:"nowrap",
          }}>
            {loading ? "Evaluating…" : "Evaluate"}
          </button>
          <button onClick={() => { clearApiKey(); setApiKeyState(""); setResult(null); setError(null); }}
            title="Clear API key" style={{background:"transparent",border:"1px solid #1a2d40",
            color:"#3a5a7a",padding:"12px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>
            ⚙
          </button>
        </div>

        {/* Loading progress */}
        {loading && progress.length > 0 && (
          <div style={{marginTop:14,display:"flex",flexWrap:"wrap",gap:8}}>
            {progress.map((p) => {
              const c = FACTOR_SIGNAL_COLOR[p.signal] || "#3a5a7a";
              return (
                <div key={p.name} style={{background:"#080f1c",border:`1px solid ${c}44`,
                  borderRadius:6,padding:"5px 10px",fontSize:11,color:c}}>
                  {p.name} {p.score !== null ? (p.score > 0 ? "+" : "") + p.score?.toFixed(2) : ""}
                </div>
              );
            })}
            {loading && <div style={{background:"#080f1c",border:"1px solid #1a2d4044",borderRadius:6,padding:"5px 10px",fontSize:11,color:"#3a5a7a",animation:"pulse 1.5s infinite"}}>fetching…</div>}
          </div>
        )}

        {error && (
          <div style={{marginTop:12,padding:"10px 14px",background:"#150808",border:"1px solid #f8717144",borderRadius:8,color:"#f87171",fontSize:13}}>
            {error}
          </div>
        )}
      </div>

      {/* Signal banner */}
      {result && sm && (
        <div style={{...card,background:sm.bg,borderColor:sm.border}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
            <div>
              <div style={{color:"#3a5a7a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:6}}>{result.ticker} — COMPOSITE SIGNAL</div>
              <div style={{display:"flex",alignItems:"baseline",gap:16}}>
                <span style={{fontSize:48,fontWeight:900,color:sm.color,letterSpacing:-1}}>{result.signal}</span>
                <div>
                  <div style={{color:sm.color,fontSize:18,fontWeight:700}}>
                    {result.composite > 0 ? "+" : ""}{result.composite.toFixed(3)}
                  </div>
                  <div style={{color:"#3a5a7a",fontSize:12}}>{result.confidence}% confidence</div>
                </div>
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{color:"#3a5a7a",fontSize:11,marginBottom:4}}>
                {result.factorCount}/{result.totalFactors} factors · {result.apiCallCount} API calls
              </div>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                {[-1, -0.5, 0, 0.5, 1].map((v) => (
                  <div key={v} style={{
                    width:8,height:8,borderRadius:"50%",
                    background: Math.abs(result.composite - v) < 0.3 ? sm.color : "#0c1824",
                    border:`1px solid ${sm.color}44`,
                  }}/>
                ))}
              </div>
              <div style={{color:"#1e3050",fontSize:10,marginTop:4}}>−1.0 ←→ +1.0 scale</div>
            </div>
          </div>
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${sm.border}`,
            color:"#3a5a7a",fontSize:12,lineHeight:1.6}}>
            {result.signal === "BUY" && "Composite score is significantly positive. Multiple factors are aligned bullishly. Consider a long position with appropriate position sizing."}
            {result.signal === "HOLD" && "Mixed signals across factors. No strong directional edge. Monitor for changes."}
            {result.signal === "SELL" && "Composite score is significantly negative. Multiple factors are flagging bearish conditions. Consider reducing or avoiding this position."}
          </div>
        </div>
      )}

      {/* Factor breakdown table */}
      {result && (
        <div style={card}>
          <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:14}}>
            FACTOR BREAKDOWN — CLICK A ROW TO EXPAND DETAILS
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            {result.factors.map((f) => {
              const sig = f.signal === "ERROR" ? "ERROR" : f.signal;
              const sigColor = FACTOR_SIGNAL_COLOR[sig] || "#3a5a7a";
              const isOpen = !!expanded[f.name];
              const keyDetail = getKeyDetail(f);
              return (
                <div key={f.name}>
                  <div
                    onClick={() => toggleExpand(f.name)}
                    style={{
                      display:"grid",gridTemplateColumns:"1fr 160px 120px 80px 36px",
                      alignItems:"center",gap:12,padding:"10px 14px",
                      background: isOpen ? "#0d1828" : "#080f1c",
                      borderRadius:isOpen ? "8px 8px 0 0" : 8,
                      border:"1px solid #1a2d40",cursor:"pointer",
                      transition:"background 0.15s",
                    }}
                  >
                    <div>
                      <div style={{color:"#c8daf0",fontSize:13,fontWeight:600}}>{f.name}</div>
                      <div style={{color:"#3a5a7a",fontSize:11,marginTop:2}}>{keyDetail}</div>
                    </div>
                    <ScoreBar score={f.score} />
                    <div style={{
                      textAlign:"center",padding:"3px 8px",borderRadius:5,
                      background:`${sigColor}18`,border:`1px solid ${sigColor}44`,
                      color:sigColor,fontSize:11,fontWeight:700,letterSpacing:0.5,
                    }}>{sig}</div>
                    <div style={{color:"#3a5a7a",fontSize:11,textAlign:"right"}}>w={f.weight}</div>
                    <div style={{color:"#3a5a7a",fontSize:13,textAlign:"center"}}>{isOpen ? "▲" : "▼"}</div>
                  </div>
                  {isOpen && <FactorDetailPanel factor={f} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Extract a short one-line summary from a factor's details for display in the table row */
function getKeyDetail(f) {
  const d = f.details || {};
  if (d.error) return d.error;
  if (d.trajectory !== undefined) return `${d.trajectory?.replace(/_/g," ")}, YoY EPS ${d.yoy_eps_growth_pct !== null ? (d.yoy_eps_growth_pct > 0 ? "+" : "") + d.yoy_eps_growth_pct?.toFixed(1) + "%" : "N/A"}`;
  if (d.trend !== undefined && (d.latest_yoy_pct !== undefined || d.latest_qoq_pct !== undefined)) return `${d.trend}, YoY ${d.latest_yoy_pct !== null ? (d.latest_yoy_pct > 0 ? "+" : "") + d.latest_yoy_pct?.toFixed(1) + "%" : "N/A"}`;
  if (d.slope_pp_per_quarter !== undefined) return `${d.trend}, Δmargin ${d.margin_change_pp > 0 ? "+" : ""}${d.margin_change_pp?.toFixed(2)}pp`;
  if (d.accruals_ratio !== undefined) return `Ratio ${d.accruals_ratio > 0 ? "+" : ""}${d.accruals_ratio?.toFixed(4)}`;
  if (d.momentum_return_pct !== undefined) return `12-1 return ${d.momentum_return_pct > 0 ? "+" : ""}${d.momentum_return_pct?.toFixed(1)}%`;
  return "";
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [docs, setDocs]             = useState(SAMPLE_DOCS);
  const [loading, setLoading]       = useState({});
  const [errors, setErrors]         = useState({});
  const [selected, setSelected]     = useState(new Set(["s1","s2","s3","s4"]));
  const [stopWords, setStopWords]   = useState(false);
  const [view, setView]             = useState("matrix");
  const [detailPair, setDetailPair] = useState(null);
  const [manualA, setManualA]       = useState("s1");
  const [manualB, setManualB]       = useState("s2");
  const [toast, setToast]           = useState(null);

  const showToast = useCallback((msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast(null),3500);},[]);

  const handleFiles = useCallback(async(files)=>{
    for(const file of files){
      const id=`u_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      setDocs(d=>[...d,{id,name:file.name,text:""}]);
      setLoading(l=>({...l,[id]:true}));
      try{
        const text=await extractText(file);
        setDocs(d=>d.map(doc=>doc.id===id?{...doc,text}:doc));
        setSelected(s=>new Set([...s,id]));
        showToast(`✓ Loaded ${file.name} (${tokenize(text).length} tokens)`);
      }catch(err){
        setErrors(e=>({...e,[id]:err.message}));
        setDocs(d=>d.map(doc=>doc.id===id?{...doc,text:`[ERROR: ${err.message}]`}:doc));
        showToast(`✗ ${file.name}: ${err.message}`,"err");
      }finally{
        setLoading(l=>({...l,[id]:false}));
      }
    }
  },[showToast]);

  const removeDoc = useCallback(id=>{
    setDocs(d=>d.filter(doc=>doc.id!==id));
    setSelected(s=>{const ns=new Set(s);ns.delete(id);return ns;});
    if(detailPair&&(detailPair.a===id||detailPair.b===id)) setDetailPair(null);
  },[detailPair]);

  const toggleSel = useCallback(id=>{
    setSelected(s=>{const ns=new Set(s);ns.has(id)?ns.delete(id):ns.add(id);return ns;});
  },[]);

  const selDocs = docs.filter(d=>selected.has(d.id)&&d.text&&!d.text.startsWith("[ERROR"));
  const pairData = useMemo(()=>{
    const map={};
    for(let i=0;i<selDocs.length;i++) for(let j=i+1;j<selDocs.length;j++){
      const a=selDocs[i],b=selDocs[j];
      const tA=tokenize(a.text,stopWords),tB=tokenize(b.text,stopWords);
      map[`${a.id}__${b.id}`]={a:a.id,b:b.id,scores:computeAllScores(tA,tB)};
    }
    return map;
  },[selDocs,stopWords]);

  const pairList=Object.values(pairData);
  const getPair=(aId,bId)=>pairData[`${aId}__${bId}`]||pairData[`${bId}__${aId}`]||null;
  const detailDocA=detailPair?docs.find(d=>d.id===detailPair.a):null;
  const detailDocB=detailPair?docs.find(d=>d.id===detailPair.b):null;
  const validDocs=docs.filter(d=>d.text&&!d.text.startsWith("[ERROR"));
  const manDocA=validDocs.find(d=>d.id===manualA);
  const manDocB=validDocs.find(d=>d.id===manualB);

  const card = {background:"#0b1420",borderRadius:12,padding:"20px 22px",border:"1px solid #1a2d40"};

  return (
    <div style={{minHeight:"100vh",background:"#060d18",paddingBottom:80}}>

      {toast&&(
        <div style={{position:"fixed",bottom:24,right:24,zIndex:9999,
          background:toast.type==="err"?"#150808":"#081508",
          border:`1px solid ${toast.type==="err"?"#f87171":"#4ade80"}55`,
          color:toast.type==="err"?"#f87171":"#4ade80",
          padding:"12px 20px",borderRadius:9,fontSize:13,
          letterSpacing:0.5,boxShadow:"0 4px 24px rgba(0,0,0,0.7)",maxWidth:360}}>
          {toast.msg}
        </div>
      )}

      {/* ── Header ── */}
      <div style={{background:"linear-gradient(135deg,#080f1e 0%,#0b1728 100%)",borderBottom:"1px solid #1a2d40",padding:"28px 36px 22px"}}>
        <div style={{fontSize:11,letterSpacing:3,color:"#1e4a8a",fontWeight:700,marginBottom:8}}>
          NBER WP 25084 · COHEN, MALLOY &amp; NGUYEN (2018)
        </div>
        <h1 style={{margin:0,fontSize:28,fontWeight:800,color:"#c8daf0",letterSpacing:-0.5}}>
          Lazy Prices — 10-K Similarity Engine
        </h1>
        <p style={{margin:"8px 0 0",color:"#2a4060",fontSize:14}}>
          Upload SEC filings and detect long/short signals based on year-over-year language changes
        </p>
      </div>

      <div style={{maxWidth:1280,margin:"0 auto",padding:"24px 20px 0"}}>
        <div style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20,alignItems:"start"}}>

          {/* ── Sidebar ── */}
          <div style={{position:"sticky",top:20}}>
            <div style={{...card,marginBottom:14}}>
              <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:12}}>UPLOAD FILINGS</div>
              <DropZone onFiles={handleFiles}/>
            </div>

            <div style={card}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700}}>DOCUMENT LIBRARY</div>
                <div style={{display:"flex",gap:6}}>
                  {[["All",()=>setSelected(new Set(docs.map(d=>d.id)))],["None",()=>setSelected(new Set())]].map(([l,fn])=>(
                    <button key={l} onClick={fn} style={{background:"transparent",border:"1px solid #1a2d40",color:"#3a5a7a",borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:11}}>{l}</button>
                  ))}
                </div>
              </div>

              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:360,overflowY:"auto"}}>
                {docs.map(doc=>(
                  <DocChip key={doc.id} doc={doc} selected={selected.has(doc.id)}
                    isLoading={!!loading[doc.id]} hasError={!!errors[doc.id]}
                    onClick={()=>toggleSel(doc.id)}
                    onRemove={doc.id.startsWith("u_")?()=>removeDoc(doc.id):null}/>
                ))}
              </div>

              <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #0c1824",display:"flex",justifyContent:"space-between",color:"#1e3050",fontSize:12}}>
                <span>{selected.size} selected · {pairList.length} pairs</span>
                <span>{docs.length} total</span>
              </div>

              <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8}}>
                <div onClick={()=>setStopWords(s=>!s)} style={{
                  width:36,height:20,borderRadius:10,cursor:"pointer",flexShrink:0,
                  background:stopWords?"#2a6bbf":"#1a2840",position:"relative",
                  border:"1px solid #1e3a5a",transition:"background 0.3s",
                }}>
                  <div style={{position:"absolute",top:3,left:stopWords?17:3,
                    width:13,height:13,borderRadius:"50%",background:"#8ab4d4",transition:"left 0.3s"}}/>
                </div>
                <span style={{color:"#3a5a7a",fontSize:12}}>Remove stop words (LM)</span>
              </div>
            </div>

            {/* Signal legend */}
            <div style={{...card,marginTop:14}}>
              <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:12}}>SIGNAL GUIDE</div>
              {[
                {c:"#4ade80",b:"LONG",      d:">85% similar"},
                {c:"#86efac",b:"MILD LONG", d:"72–85% similar"},
                {c:"#facc15",b:"NEUTRAL",   d:"58–72% similar"},
                {c:"#fb923c",b:"MILD SHORT",d:"42–58% similar"},
                {c:"#f87171",b:"SHORT",     d:"<42% similar"},
              ].map(x=>(
                <div key={x.b} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <div style={{width:64,textAlign:"center",background:`${x.c}18`,color:x.c,border:`1px solid ${x.c}44`,
                    padding:"2px 6px",borderRadius:5,fontSize:10,fontWeight:700,letterSpacing:0.5,flexShrink:0}}>{x.b}</div>
                  <span style={{color:"#3a5a7a",fontSize:12}}>{x.d}</span>
                </div>
              ))}
              <div style={{color:"#1e3050",fontSize:11,marginTop:10,lineHeight:1.6}}>
                Based on quintile sorts from Table II of the paper. Returns accrue over 6–18 months with no reversal.
              </div>
            </div>
          </div>

          {/* ── Main panel ── */}
          <div>
            <div style={{display:"flex",gap:4,marginBottom:18,alignItems:"center"}}>
              {[["matrix","Matrix"],["table","Ranked Table"],["manual","Manual Compare"],["evaluate","Evaluate Ticker"]].map(([id,label])=>(
                <button key={id} onClick={()=>{setView(id);setDetailPair(null);}} style={{
                  padding:"9px 20px",borderRadius:8,border:"none",cursor:"pointer",
                  fontSize:13,fontWeight:600,
                  background:view===id?"#162033":"transparent",
                  color:view===id?"#c8daf0":"#3a5a7a",
                  borderBottom:view===id?"2px solid #2a6bbf":"2px solid transparent",
                }}>{label}</button>
              ))}
              {pairList.length>0&&(
                <span style={{marginLeft:"auto",color:"#1e3050",fontSize:12}}>{pairList.length} pairs computed</span>
              )}
            </div>

            {selDocs.length<2&&view!=="manual"&&view!=="evaluate"&&(
              <div style={{...card,padding:"60px 32px",textAlign:"center"}}>
                <div style={{fontSize:36,marginBottom:16}}>📄</div>
                <div style={{color:"#2a4060",fontSize:16,marginBottom:8}}>Select at least 2 documents to begin analysis</div>
                <div style={{color:"#1a2840",fontSize:13}}>Upload 10-K filings above, or use the pre-loaded Baxter and Herbalife examples from the paper</div>
              </div>
            )}

            {/* MATRIX */}
            {view==="matrix"&&selDocs.length>=2&&(
              <div style={card}>
                <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:16}}>
                  PAIRWISE SIMILARITY MATRIX — CLICK ANY CELL FOR FULL SIGNAL ANALYSIS
                </div>
                <div style={{overflowX:"auto"}}>
                  <table style={{borderCollapse:"separate",borderSpacing:4}}>
                    <thead>
                      <tr>
                        <td style={{minWidth:110}}/>
                        {selDocs.map(d=>(
                          <td key={d.id} style={{padding:"0 4px 14px",minWidth:90}}>
                            <div style={{color:"#2a4060",fontSize:11,overflow:"hidden",textOverflow:"ellipsis",
                              whiteSpace:"nowrap",maxWidth:90,
                              transform:"rotate(-20deg)",transformOrigin:"left bottom",marginLeft:10}}>
                              {d.name.replace(/\.(txt|pdf|docx|csv)$/i,"").slice(0,20)}
                            </div>
                          </td>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selDocs.map((dA,i)=>(
                        <tr key={dA.id}>
                          <td style={{paddingRight:8}}>
                            <div style={{color:"#2a4060",fontSize:11,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:110}}>
                              {dA.name.replace(/\.(txt|pdf|docx|csv)$/i,"").slice(0,16)}
                            </div>
                          </td>
                          {selDocs.map((dB,j)=>(
                            <td key={dB.id} style={{padding:3,minWidth:90,height:66}}>
                              <MatrixCell diagonal={i===j} scores={i!==j?getPair(dA.id,dB.id)?.scores:null}
                                onClick={i!==j?()=>setDetailPair({a:dA.id,b:dB.id}):undefined}/>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:16,marginTop:16,flexWrap:"wrap"}}>
                  {[{c:"#4ade80",l:"▲ LONG (>85%)"},{c:"#86efac",l:"↗ MILD LONG"},{c:"#facc15",l:"→ NEUTRAL"},{c:"#fb923c",l:"↘ MILD SHORT"},{c:"#f87171",l:"▼ SHORT (<42%)"}].map(x=>(
                    <div key={x.l} style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:10,height:10,borderRadius:3,background:x.c}}/>
                      <span style={{color:"#2a4060",fontSize:11}}>{x.l}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TABLE */}
            {view==="table"&&selDocs.length>=2&&(
              <div style={card}>
                <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:14}}>
                  ALL PAIRS RANKED BY SIMILARITY — LOWEST = STRONGEST SHORT SIGNAL — CLICK ROW FOR DETAIL
                </div>
                <BatchTable pairs={pairList} docs={docs} onSelect={(a,b)=>setDetailPair({a,b})}/>
              </div>
            )}

            {/* MANUAL */}
            {view==="manual"&&(
              <div style={card}>
                <div style={{color:"#1e4a8a",fontSize:11,letterSpacing:1.5,fontWeight:700,marginBottom:16}}>
                  SELECT TWO DOCUMENTS TO COMPARE
                </div>
                {validDocs.length<2?(
                  <div style={{color:"#2a4060",fontSize:14,textAlign:"center",padding:"40px"}}>
                    At least two documents with text are required
                  </div>
                ):(
                  <>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:4}}>
                      {[{label:"Document A — Prior Year (T−1)",val:manualA,set:setManualA},{label:"Document B — Current Year (T)",val:manualB,set:setManualB}].map(({label,val,set})=>(
                        <div key={label}>
                          <div style={{color:"#3a5a7a",fontSize:12,marginBottom:7}}>{label}</div>
                          <select value={val} onChange={e=>set(e.target.value)} style={{
                            width:"100%",background:"#080f1c",border:"1px solid #1a2d40",
                            color:"#7a9abf",padding:"10px 14px",borderRadius:8,fontSize:13,cursor:"pointer",outline:"none",
                          }}>
                            {validDocs.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                    {manDocA&&manDocB&&manualA!==manualB?(
                      <DetailPanel docA={manDocA} docB={manDocB} stopWords={stopWords} onClose={null}/>
                    ):(
                      <div style={{color:"#2a4060",fontSize:13,textAlign:"center",padding:"24px"}}>Select two different documents</div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* EVALUATE */}
            {view==="evaluate"&&(
              <TickerEvaluator />
            )}

            {detailPair&&detailDocA&&detailDocB&&view!=="manual"&&view!=="evaluate"&&(
              <DetailPanel docA={detailDocA} docB={detailDocB} stopWords={stopWords} onClose={()=>setDetailPair(null)}/>
            )}
          </div>
        </div>

        <div style={{marginTop:36,textAlign:"center",color:"#0c1624",fontSize:11,letterSpacing:1}}>
          LAZY PRICES · COHEN, MALLOY &amp; NGUYEN · NBER WP 25084 · COSINE · JACCARD · MIN-EDIT · SIMPLE DIFF
        </div>
      </div>
    </div>
  );
}
