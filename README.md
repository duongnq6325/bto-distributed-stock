# BTO Stock Trading Platform

**Project #24 — Category 3: Distributed Concurrency Control**  
**Basic Timestamp Ordering (BTO) on a 3-Site Distributed Stock Trading System**  
Özsu & Valduriez — *Principles of Distributed Database Systems*, 4th Ed., **Algorithm 5.5**

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [BTO Algorithm](#3-bto-algorithm-özsu--valduriez-algorithm-55)
4. [Dataset](#4-dataset)
5. [Prerequisites](#5-prerequisites)
6. [Project Structure](#6-project-structure)
7. [Quick Start](#7-quick-start)
8. [Running Benchmark](#8-running-benchmark)
9. [Web Dashboard](#9-web-dashboard)
10. [Failure Scenario Demo](#10-failure-scenario-demo)
11. [Benchmark Results](#11-benchmark-results)
12. [References](#12-references)

---

## 1. Overview

This project implements **Basic Timestamp Ordering (BTO)** concurrency control on a distributed stock trading platform. Five real stock symbols are horizontally fragmented across three MySQL sites. The system enforces serializable execution **without locks**, eliminating deadlocks at the cost of higher abort rates under heavy load.

**Core properties demonstrated:**
- Deadlock-free by design (no waiting — immediate abort and restart)
- Fragmentation Transparency (clients unaware of data location)
- Two-Phase Commit (2PC) across 3 distributed sites
- Abort rate increases monotonically with transaction load — Özsu §5.2.2

---

## 2. System Architecture

```
Browser  http://localhost:3000
         │  Web Dashboard (real-time SSE + REST)
         ▼
┌─────────────────────────────────────────────┐
│         COORDINATOR  :3000                  │
│  • ts = Date.now()  (Timestamp assignment)  │
│  • Routes: A–C→S1 | D–N→S2 | O–Z→S3       │
│  • 2PC: PREPARE → COMMIT / ABORT            │
│  • Serves dashboard at GET /                │
└──────────┬───────────┬──────────────┬───────┘
      :3001 │      :3002│         :3003│
            ▼           ▼              ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │  SITE 1  │ │  SITE 2  │ │  SITE 3  │
     │ Frag A–C │ │ Frag D–N │ │ Frag O–Z │
     │AAPL, BTC │ │FPT, MSFT │ │   VNM    │
     │MySQL:3301│ │MySQL:3302│ │MySQL:3303│
     └──────────┘ └──────────┘ └──────────┘
```

### Port Map

| Component | File | HTTP | MySQL |
|-----------|------|------|-------|
| Coordinator + Dashboard | `coordinator.js` | :3000 | — |
| Site 1 — Fragment A–C | `site_server.js 3001` | :3001 | :3301 |
| Site 2 — Fragment D–N | `site_server.js 3002` | :3002 | :3302 |
| Site 3 — Fragment O–Z | `site_server.js 3003` | :3003 | :3303 |

### Horizontal Fragmentation Rule

| Fragment | First Letter | Symbols | Site |
|----------|-------------|---------|------|
| A–C | A, B, C | AAPL, BTC | Site 1 |
| D–N | D–N | FPT, MSFT | Site 2 |
| O–Z | O–Z | VNM | Site 3 |

---

## 3. BTO Algorithm (Özsu & Valduriez, Algorithm 5.5)

Each transaction `T` receives timestamp `ts(T) = Date.now()` at the Coordinator.  
Each data item `x` maintains `R_TS(x)` and `W_TS(x)` in MySQL.

```
READ x:
  if ts(T) >= W_TS(x)  →  ACCEPT,  R_TS(x) ← max(R_TS(x), ts(T))
  if ts(T) <  W_TS(x)  →  REJECT   (reading data overwritten by a future tx)

WRITE x:
  if ts(T) >= R_TS(x) AND ts(T) >= W_TS(x)  →  ACCEPT,  W_TS(x) ← ts(T)
  else                                         →  REJECT   (writing into the past)
```

On **REJECT**: Coordinator returns HTTP 409, sends ABORT to site, transaction restarts.  
**Key property**: BTO never causes deadlocks. Trade-off: abort rate rises with load.

### Two-Phase Commit Flow

```
Coordinator          Site
    │── POST /prepare ──►│  Check BTO rules, buffer tx
    │◄── READY (200) ────│
    │── POST /commit ──►│  Write to MySQL, update R_TS/W_TS
    │◄── ACK (200) ──────│

On conflict:
    │◄── ABORT (409) ────│  BTO rule violated
    │── POST /abort ───►│  Clear buffer
```

---

## 4. Dataset

**Source**: Anchor prices from Yahoo Finance / SSI Research (April–May 2025).  
**Method**: Intra-day ticks generated using Geometric Brownian Motion (GBM):

```
S(t+dt) = S(t) × exp( (−σ²/2)×dt + σ×√dt×Z )    Z ~ N(0,1)
```

| Symbol | Exchange | Anchor Price | Volatility σ | Ticks/Day |
|--------|----------|-------------|-------------|-----------|
| AAPL | NASDAQ | $223.19 | 1.2% | 78 |
| BTC | Crypto | $85,187 | 2.8% | 144 |
| FPT | HOSE | 118,500 VND | 1.0% | 50 |
| MSFT | NASDAQ | $378.80 | 1.3% | 78 |
| VNM | HOSE | 68,500 VND | 0.8% | 50 |

Total: **12,000 price ticks** across 30 trading days × 5 symbols.

---

## 5. Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 18.x | Runtime |
| Docker Desktop | ≥ 4.x | MySQL containers |
| npm | ≥ 9.x | Package manager |

---

## 6. Project Structure

```
bto-stock-platform/
├── public/
│   └── index.html          ← Web Dashboard (real-time)
├── data/
│   └── stock_history.csv   ← 12,000 GBM-derived price ticks
│
├── coordinator.js           ← Transaction Manager + Dashboard server
├── site_server.js           ← Data Manager (BTO-SC, shared by 3 sites)
├── docker-compose.yml       ← 3 MySQL containers
├── generate_data.js         ← Generates stock_history.csv
├── seed_realistic.js        ← Seeds initial prices into all 3 DBs
├── simulator.js             ← Benchmark: 5 TPS scenarios → CSV output
├── test_conflict.js         ← Manual BTO conflict test using forcedTS
│
├── benchmark_results.csv    ← Output after running simulator.js
├── package.json
├── .gitignore
└── README.md
```

---

## 7. Quick Start

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Start MySQL containers
```bash
docker-compose up -d

# Verify — must see 3 containers:
docker ps
# bto_site1  0.0.0.0:3301->3306
# bto_site2  0.0.0.0:3302->3306
# bto_site3  0.0.0.0:3303->3306
```

### Step 3 — Generate dataset (run once)
```bash
node generate_data.js
# Output: ./data/stock_history.csv  (12,000 ticks)
```

### Step 4 — Seed database
```bash
node seed_realistic.js
# AAPL, BTC → Site 1 | FPT, MSFT → Site 2 | VNM → Site 3
```

### Step 5 — Start all nodes (4 separate terminals)
```bash
# Terminal 1 — Coordinator + Dashboard
node coordinator.js

# Terminal 2 — Site 1 (Fragment A–C: AAPL, BTC)
node site_server.js 3001

# Terminal 3 — Site 2 (Fragment D–N: FPT, MSFT)
node site_server.js 3002

# Terminal 4 — Site 3 (Fragment O–Z: VNM)
node site_server.js 3003
```

### Step 6 — Open Dashboard
```
http://localhost:3000
```

### Step 7 — Test single transaction (Windows CMD)
```cmd
curl -X POST http://localhost:3000/api/transaction -H "Content-Type: application/json" -d "{\"symbol\":\"FPT\",\"type\":\"WRITE\",\"newPrice\":118.5}"
```
Expected: `{"status":"SUCCESS"}`

---

## 8. Running Benchmark

```bash
# Terminal 5 — run after all 4 nodes are online
node simulator.js
```

Simulator fires 5 scenarios automatically. Results auto-appear in dashboard after each run.

| TPS | Strategy | Window | Description |
|-----|----------|--------|-------------|
| 10 | spread | 300ms | Low load — all 5 symbols |
| 50 | spread | 600ms | Moderate load |
| 100 | spread | 900ms | High load |
| 200 | spread | 1200ms | Very high load |
| 500 | spread | 1800ms | Saturation |

### Manual BTO conflict test
```bash
node test_conflict.js
# Transaction 1 (new ts)  → COMMIT ✓
# Transaction 2 (old ts)  → ABORT  ✗  (ts < W_TS)
```

---

## 9. Web Dashboard

Open `http://localhost:3000` after starting the coordinator.

| Panel | Description |
|-------|-------------|
| **KPI Bar** | Total TX, Commits, BTO Aborts, Errors, Uptime — updates every 1.5s |
| **3 Site Cards** | ONLINE/OFFLINE, current prices, commit/abort counts per site |
| **Live TX Feed** | Every transaction streams via SSE — green=COMMIT, red=ABORT |
| **Abort Rate Chart** | Line chart updating live |
| **Manual Controls** | Send transaction from browser; Kill/Start nodes via buttons |
| **Benchmark Table** | Auto-updates from CSV after each simulator run |

---

## 10. Failure Scenario Demo

### Kill Site 2 (demonstrates "What happens when Node B dies?")

**Setup**: All 3 nodes running, simulator idle.

**Step 1** — Kill via dashboard button "⚡ Kill Site 2", or terminal:
```bash
docker stop bto_site2
```

**Expected**:
- Dashboard: Site 2 card turns RED immediately
- Coordinator terminal: `[CRITICAL] Site :3002 Offline. Initiating 2PC Global Abort...`
- Transactions targeting FPT/MSFT → HTTP 500, no data corruption
- Transactions targeting AAPL/BTC (Site 1) and VNM (Site 3) → **continue normally**
- No deadlock, no crash

**Step 2** — Recover:
```bash
docker start bto_site2
# or click "▶ Start Site 2" on dashboard
```
Site 2 reconnects automatically. Dashboard card turns GREEN.

---

## 11. Benchmark Results

> **Important**: Run benchmark with ALL 3 sites online for clean results.

| TPS | Total | Commit | BTO Abort | Success% | Abort% |
|-----|-------|--------|-----------|---------|--------|
| 10 | 50 | 46 | 4 | 92.0% | **8.0%** |
| 50 | 250 | 144 | 106 | 57.6% | **42.4%** |
| 100 | 500 | 196 | 304 | 39.2% | **60.8%** |
| 200 | 1,000 | 233 | 767 | 23.3% | **76.7%** |
| 500 | 2,500 | 365 | 2,135 | 14.6% | **85.4%** |

**Key finding**: BTO Abort% increases monotonically (8% → 85%) as TPS increases.

**Theoretical justification** (Özsu & Valduriez §5.2.2):
> *"The basic TO algorithm never causes deadlocks — the penalty of deadlock freedom is potential restart of a transaction numerous times."*

As TPS increases, W_TS is updated more frequently. Transactions arriving with `ts < W_TS` are rejected and must restart — this is the fundamental BTO trade-off: **deadlock-free at the cost of higher abort rate under heavy load**.

---

## 12. References

Özsu, M.T. & Valduriez, P. (2020). *Principles of Distributed Database Systems* (4th ed.). Springer.
- §5.2.2 — Basic Timestamp Ordering
- Algorithm 5.5 — BTO-SC Scheduler
- §4.1 — Horizontal Fragmentation
- §12.2 — Two-Phase Commit Protocol