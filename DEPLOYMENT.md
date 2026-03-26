# Lazy Prices — Deployment Guide

> From your downloaded zip to a live `.net` website in ~20 minutes.

---

## What's in this folder

```
lazy-prices-app/
├── public/
│   └── favicon.svg          ← browser tab icon
├── src/
│   ├── App.jsx              ← the full application
│   ├── main.jsx             ← React entry point
│   └── index.css            ← global styles
├── .gitignore
├── index.html               ← HTML shell
├── package.json             ← dependencies
└── vite.config.js           ← build config
```

---

## Prerequisites (install once)

| Tool | Install |
|------|---------|
| **Node.js 18+** | https://nodejs.org → click "LTS" → download & run installer |
| **Git** | https://git-scm.com/downloads → download & run installer |

Verify both installed — open Terminal (Mac) or Command Prompt (Windows) and run:
```bash
node --version   # should print v18.x.x or higher
git --version    # should print git version 2.x.x
```

---

## Step 1 — Set up the project locally

1. Unzip the downloaded file. You'll get a folder called `lazy-prices-app`.

2. Open Terminal / Command Prompt and navigate into it:
   ```bash
   cd path/to/lazy-prices-app
   # Example on Mac:  cd ~/Downloads/lazy-prices-app
   # Example on Win:  cd C:\Users\You\Downloads\lazy-prices-app
   ```

3. Install dependencies:
   ```bash
   npm install
   ```
   This downloads React, Vite, mammoth, and pdfjs-dist into a `node_modules/` folder.
   Takes about 30–60 seconds.

4. Start the local dev server to confirm everything works:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173 in your browser — you should see the app.
   Press `Ctrl+C` to stop the server when done.

---

## Step 2 — Buy your .net domain (~5 minutes)

1. Go to **https://www.namecheap.com**
2. Search for your desired name (e.g. `lazypricer.net`)
3. Add to cart and check out (~$10–13/year)
4. Create an account / log in
5. Leave the Namecheap tab open — you'll need it in Step 5

---

## Step 3 — Push your code to GitHub (~5 minutes)

1. Create a free account at **https://github.com** if you don't have one.

2. Click the **+** icon (top right) → **New repository**
   - Name it: `lazy-prices-app`
   - Keep it **Public** (required for free Vercel hosting)
   - Do **not** check "Add a README" (we already have our files)
   - Click **Create repository**

3. Back in your terminal (inside the `lazy-prices-app` folder):
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/lazy-prices-app.git
   git push -u origin main
   ```
   Replace `YOUR_USERNAME` with your actual GitHub username.

   > **First time using Git?** GitHub may ask you to log in — use your GitHub username and a Personal Access Token (not your password). Create one at: GitHub → Settings → Developer settings → Personal access tokens → Generate new token (check the `repo` scope).

---

## Step 4 — Deploy to Vercel (~3 minutes)

1. Go to **https://vercel.com** and click **Sign Up** → choose **Continue with GitHub**

2. Click **Add New** → **Project**

3. Find `lazy-prices-app` in the list and click **Import**

4. Vercel auto-detects Vite. Leave all settings as defaults.

5. Click **Deploy**

   Vercel builds and deploys your app. In about 60 seconds you'll see:
   ```
   🎉  Your project is live at: lazy-prices-app.vercel.app
   ```
   Visit that URL to confirm the app is working.

---

## Step 5 — Connect your .net domain (~10 minutes)

**In Vercel:**

1. Go to your project dashboard → **Settings** → **Domains**
2. Type your domain (e.g. `lazypricer.net`) and click **Add**
3. Also add `www.lazypricer.net` and click **Add**
4. Vercel shows you two DNS records — keep this tab open

**In Namecheap:**

1. Go to **Dashboard** → find your domain → click **Manage**
2. Click the **Advanced DNS** tab
3. Delete any existing A records or CNAME records for `@` and `www`
4. Add the records Vercel gave you:

   | Type  | Host | Value                  |
   |-------|------|------------------------|
   | A     | @    | 76.76.21.21            |
   | CNAME | www  | cname.vercel-dns.com   |

5. Click the ✓ checkmark to save each record

**Wait for DNS to propagate:**
- Usually 5–30 minutes, sometimes up to 24 hours
- You can check progress at https://dnschecker.org — enter your domain and look for green checkmarks spreading globally

Once propagated, `https://lazypricer.net` will load your app with a padlock (Vercel provisions the SSL certificate automatically — free).

---

## Step 6 — Future updates

Whenever you make changes to the code, just run:
```bash
git add .
git commit -m "describe your change"
git push
```
Vercel detects the push and automatically redeploys within ~30 seconds.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails | Make sure Node.js 18+ is installed: `node --version` |
| App builds but PDF parsing fails | PDFs must have embedded text (not scanned images) |
| Domain not loading after 1 hour | Double-check DNS records in Namecheap — no trailing dots, correct values |
| Vercel build error | Check the Vercel build log — usually a missing dependency; run `npm install <package>` locally and push |
| `git push` asks for password | Use a Personal Access Token, not your GitHub password |

---

## Cost summary

| Item | Cost |
|------|------|
| .net domain (Namecheap) | ~$11/year |
| Vercel hosting | Free |
| SSL certificate | Free (via Vercel) |
| **Total** | **~$11/year** |

---

*Built on Cohen, Malloy & Nguyen (2018) "Lazy Prices", NBER Working Paper 25084.*
