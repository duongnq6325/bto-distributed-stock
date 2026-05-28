# 📈 BTO Stock Trading Platform

> **Project #24 — Category 3: Distributed Concurrency Control**  
> *Basic Timestamp Ordering (BTO) — Distributed Stock Trading System*  
> Özsu & Valduriez, *Principles of Distributed Database Systems* 4th Ed., **Algorithm 5.5**

---

## 🏗 System Architecture

```
Browser http://localhost:3000
         │  (Web Dashboard — real-time)
         │ SSE + REST polling
         ▼
┌─────────────────────────────────────────────┐
│          COORDINATOR  :3000                 │
│  • Assigns ts = Date.now()                  │
│  • Routes: A–H→S1  I–P→S2  Q–Z→S3         │
│  • 2PC: PREPARE → COMMIT / ABORT            │
│  • Serves dashboard at GET /                │
└────────┬──────────────┬────────────┬────────┘
    HTTP │:3001    HTTP │:3002  HTTP │:3003
         ▼              ▼            ▼
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │  SITE 1  │  │  SITE 2  │  │  SITE 3  │
  │ Frag A–H │  │ Frag I–P │  │ Frag Q–Z │
  │AAPL, BTC │  │FPT, MSFT │  │   VNM    │
  │MySQL:3301│  │MySQL:3302│  │MySQL:3303│
  └──────────┘  └──────────┘  └──────────┘
```

### Port Map

| Component | File | HTTP Port | MySQL Port |
|-----------|------|-----------|-----------|
| Coordinator | `coordinator.js` | `:3000` | — |
| Site 1 | `site_server.js 3001` | `:3001` | `:3301` |
| Site 2 | `site_server.js 3002` | `:3002` | `:3302` |
| Site 3 | `site_server.js 3003` | `:3003` | `:3303` |

---

## 📁 Project Structure

```
bto-stock-platform/
├── public/
│   └── index.html          ← Web Dashboard (auto-served by coordinator)
├── data/
│   └── stock_history.csv   ← 12,000 price ticks (GBM-derived)
│
├── coordinator.js           ← Transaction Manager + Dashboard server
├── site_server.js           ← Data Manager (shared by all 3 sites)
├── docker-compose.yml       ← 3 MySQL containers
├── generate_data.js         ← Generates stock_history.csv
├── seed_realistic.js        ← Seeds initial prices into all 3 DBs
├── simulator.js             ← Benchmark (5 TPS scenarios)
├── test_conflict.js         ← Manual BTO conflict test
└── package.json
```

---

## ⚡ Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start MySQL containers
```bash
docker-compose up -d

# Verify — must see 3 containers:
docker ps
# bto_site1  0.0.0.0:3301->3306
# bto_site2  0.0.0.0:3302->3306
# bto_site3  0.0.0.0:3303->3306
```

### 3. Generate dataset (run once)
```bash
node generate_data.js
# Output: ./data/stock_history.csv (12,000 ticks)
```

### 4. Seed database
```bash
node seed_realistic.js
# Seeds: AAPL,BTC → Site1 | FPT,MSFT → Site2 | VNM → Site3
```

### 5. Start all nodes (4 terminals)

```bash
# Terminal 1 — Coordinator + Dashboard
node coordinator.js

# Terminal 2 — Site 1 (Fragment A–H)
node site_server.js 3001

# Terminal 3 — Site 2 (Fragment I–P)
node site_server.js 3002

# Terminal 4 — Site 3 (Fragment Q–Z)
node site_server.js 3003
```

### 6. Open Dashboard
```
http://localhost:3000
```

### 7. Run benchmark
```bash
# Terminal 5
node simulator.js
```

---

## 🌐 Web Dashboard

The dashboard at `http://localhost:3000` shows:

| Panel | Description |
|-------|-------------|
| **KPI Bar** | Total TX, Commits, BTO Aborts, Errors, Uptime — updates every 1.5s |
| **3 Site Cards** | ONLINE/OFFLINE status, current stock prices, commit/abort counts per site |
| **Live TX Feed** | Every transaction streams in real-time via SSE — green=COMMIT, red=ABORT |
| **Abort Rate Chart** | Line chart updating live showing BTO abort % over time |
| **Manual Controls** | Send a transaction directly from browser; kill-node command display |

---

## 🔬 BTO Algorithm (Özsu Algorithm 5.5)

Each transaction `T` gets timestamp `ts(T) = Date.now()` at the Coordinator.

```
READ  x:  ts(T) >= wts(x)              → ACCEPT, update rts(x)
          ts(T) <  wts(x)              → REJECT  (read too late)

WRITE x:  ts(T) >= rts(x) AND
          ts(T) >= wts(x)              → ACCEPT, update wts(x)
          else                         → REJECT  (write too late)
```

On **REJECT** → HTTP 409 → Coordinator sends ABORT → transaction restarts.  
**Key property**: BTO is deadlock-free. Trade-off: abort rate increases with load.

---

## 💀 Failure Scenario — "Kill Node B"

**Setup**: Run simulator.js at 100 TPS with VNM (routed to Site 3).

**Step 1** — Kill Site 3 while system is running:
```bash
docker stop bto_site3
```

**Expected in Coordinator terminal**:
```
[CRITICAL] Site :3003 Offline. Initiating 2PC Global Abort...
```

**Expected in Dashboard**: Site 3 card turns RED immediately — "OFFLINE"

**Expected behavior**:
- All transactions to Site 3 (VNM) → HTTP 500, no data corruption
- Transactions to Site 1 (AAPL/BTC) and Site 2 (FPT/MSFT) → **continue normally**
- No deadlock, no crash, no data loss

**Step 2** — Recover:
```bash
docker start bto_site3
```
Site 3 reconnects automatically. Dashboard card turns GREEN.

---

## 📊 Benchmark Results

| TPS | Strategy | Commit% | BTO Abort% | Sys Error% |
|-----|----------|---------|-----------|-----------|
| 10 | spread | 84.00% | 16.00% | 0.00% |
| 50 | spread | 43.60% | 54.40% | 2.00% |
| 100 | hot2 | 32.20% | 65.60% | 2.20% |
| 200 | hot1 | 28.00% | 70.80% | 1.20% |
| 500 | hot1 | 25.96% | 73.16% | 0.88% |

**Observation**: BTO Abort% increases monotonically 16% → 73% as TPS increases.

> *"The basic TO algorithm never causes deadlocks — the penalty of deadlock freedom  
> is potential restart of a transaction numerous times."*  
> — Özsu & Valduriez, §5.2.2

---

## 🎯 Demo Script (for screen recording)

**Minute 0:30** — Show dashboard at `http://localhost:3000`. Point out 3 site cards all GREEN.

**Minute 1:00** — Send a manual WRITE via dashboard controls:
- Symbol: FPT, Type: WRITE, Price: 119.50 → click SEND
- Show green COMMIT in TX feed and Site 2 price updating live

**Minute 1:30** — Run `node simulator.js` in terminal
- Show TX feed flooding with green/red entries
- Show abort rate chart climbing

**Minute 2:30** — Kill Site 3 mid-run:
```bash
docker stop bto_site3
```
- Show Site 3 card turning RED in dashboard
- Show `[CRITICAL]` log in coordinator terminal
- Show Site 1 and Site 2 continuing normally

**Minute 3:30** — Recover Site 3:
```bash
docker start bto_site3
```
- Show Site 3 card turning GREEN again

**Minute 4:00** — Show final benchmark CSV results table

---

## 📦 Dataset

| Symbol | Exchange | Anchor Price | Volatility σ | Ticks/Day |
|--------|----------|-------------|-------------|-----------|
| AAPL | NASDAQ | $223.19 | 1.2% | 78 |
| BTC | Crypto | $85,187 | 2.8% | 144 |
| FPT | HOSE | 118,500 VND | 1.0% | 50 |
| MSFT | NASDAQ | $378.80 | 1.3% | 78 |
| VNM | HOSE | 68,500 VND | 0.8% | 50 |

Anchor prices: Yahoo Finance / SSI Research (April–May 2025).  
Intra-day ticks: **Geometric Brownian Motion** — `S(t+dt) = S(t) × exp(−σ²dt/2 + σ√dt × Z)`, Z ~ N(0,1).

---

## 🛠 Manual Test — BTO Conflict

```bash
node test_conflict.js
```

Sends two transactions for FPT:
1. Transaction 1 (new timestamp) → **COMMIT** ✓
2. Transaction 2 (timestamp 1 hour ago via `forcedTS`) → **ABORT** ✗ (BTO: ts < W_TS)

This proves the BTO rule is enforced correctly.

---

## 📚 References

- Özsu, M.T. & Valduriez, P. (2020). *Principles of Distributed Database Systems* (4th ed.). Springer. §5.2.2, Algorithm 5.5.