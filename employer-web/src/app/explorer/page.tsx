"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";

const RPC_URL          = "https://testnet-rpc.monad.xyz";
const CONTRACT_ADDRESS = "0x1a8d74e1ADf1Be715e20d39ccF7637b8486b5899";
const EXPLORER_BASE    = "https://monad-testnet.socialscan.io";
const BATCH_SIZE       = 100;
const HISTORY_DEPTH    = 2000;

const CONTRACT_ABI = [
  "event IntentPublished(bytes32 indexed intentId, address indexed employer, uint256 bounty, uint256 minScore, string rawJsonSchema)",
  "event IntentSolved(bytes32 indexed intentId, address indexed worker, string resultHash, string dataUrl)",
  "event IntentSettled(bytes32 indexed intentId, address indexed worker, uint256 payout)",
];

interface IntentData {
  id: string;
  employer: string;
  worker?: string;
  bounty: string;
  bountyWei: bigint;
  status: "Pending" | "Solved" | "Settled";
  taskType?: string;
}

interface ProtocolStats {
  tvl: bigint;
  totalIntents: number;
  activeWorkers: Set<string>;
  activeEmployers: Set<string>;
  settledCount: number;
  workerEarnings: Map<string, bigint>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return (
    <button onClick={handleCopy} className="ml-1.5 text-gray-500 hover:text-gray-300 transition-colors" title="Copy">
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      )}
    </button>
  );
}

function StatCard({ label, value, sub, accent = "text-white" }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</span>
      <span className={`text-2xl font-bold tracking-tight ${accent}`}>{value}</span>
      {sub && <span className="text-xs text-gray-600">{sub}</span>}
    </div>
  );
}

export default function Explorer() {
  const [intents, setIntents] = useState<IntentData[]>([]);
  const [stats, setStats] = useState<ProtocolStats>({
    tvl: 0n, totalIntents: 0, activeWorkers: new Set(), activeEmployers: new Set(), settledCount: 0, workerEarnings: new Map(),
  });
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let stopped = false;
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

    const intentMap  = new Map<string, IntentData>();
    const pStats: ProtocolStats = {
      tvl: 0n, totalIntents: 0, activeWorkers: new Set(), activeEmployers: new Set(), settledCount: 0, workerEarnings: new Map(),
    };

    const recalcStats = () => {
      let tvl = 0n;
      let settled = 0;
      for (const i of intentMap.values()) {
        if (i.status === "Pending" || i.status === "Solved") tvl += i.bountyWei;
        if (i.status === "Settled") settled++;
      }
      pStats.tvl = tvl;
      pStats.totalIntents = intentMap.size;
      pStats.settledCount = settled;
    };

    const flush = () => {
      recalcStats();
      setIntents(Array.from(intentMap.values()).reverse());
      setStats({ ...pStats, activeWorkers: new Set(pStats.activeWorkers), activeEmployers: new Set(pStats.activeEmployers), workerEarnings: new Map(pStats.workerEarnings) });
      setLastUpdated(new Date());
    };

    const applyPublished = (id: string, employer: string, bounty: bigint, _minScore: bigint, raw: string) => {
      let taskType = "Unknown";
      try { taskType = JSON.parse(raw).task_type; } catch { /* ignore */ }
      if (!intentMap.has(id)) {
        intentMap.set(id, { id, employer, bounty: ethers.formatEther(bounty), bountyWei: bounty, status: "Pending", taskType });
        pStats.activeEmployers.add(employer.toLowerCase());
      }
    };

    const applySolved = (id: string, worker: string) => {
      const e = intentMap.get(id);
      if (e) intentMap.set(id, { ...e, status: "Solved", worker });
      pStats.activeWorkers.add(worker.toLowerCase());
    };

    const applySettled = (id: string, _recipient: string, payout: bigint) => {
      const e = intentMap.get(id);
      if (e) {
        intentMap.set(id, { ...e, status: "Settled" });
        if (e.worker) {
          const prev = pStats.workerEarnings.get(e.worker.toLowerCase()) ?? 0n;
          pStats.workerEarnings.set(e.worker.toLowerCase(), prev + payout);
        }
      }
    };

    async function queryBatched(filter: ethers.ContractEventName, from: number, to: number) {
      const logs: (ethers.Log | ethers.EventLog)[] = [];
      for (let s = from; s <= to; s += BATCH_SIZE) {
        logs.push(...await contract.queryFilter(filter, s, Math.min(s + BATCH_SIZE - 1, to)));
      }
      return logs;
    }

    async function init() {
      try {
        await provider.ready;
        setIsConnected(true);

        const head = await provider.getBlockNumber();
        const from = Math.max(0, head - HISTORY_DEPTH);

        const [pub, sol, stl] = await Promise.all([
          queryBatched(contract.filters.IntentPublished(), from, head),
          queryBatched(contract.filters.IntentSolved(), from, head),
          queryBatched(contract.filters.IntentSettled(), from, head),
        ]);

        for (const l of pub)  { const e = l as ethers.EventLog; applyPublished(e.args[0], e.args[1], e.args[2], e.args[3], e.args[4]); }
        for (const l of sol)  { const e = l as ethers.EventLog; applySolved(e.args[0], e.args[1]); }
        for (const l of stl)  { const e = l as ethers.EventLog; applySettled(e.args[0], e.args[1], e.args[2]); }
        flush();

        let lastPolled = head;
        const poll = async () => {
          if (stopped) return;
          try {
            const latest = await provider.getBlockNumber();
            if (latest > lastPolled) {
              const [p, s, t] = await Promise.all([
                queryBatched(contract.filters.IntentPublished(), lastPolled + 1, latest),
                queryBatched(contract.filters.IntentSolved(), lastPolled + 1, latest),
                queryBatched(contract.filters.IntentSettled(), lastPolled + 1, latest),
              ]);
              let changed = false;
              for (const l of p) { const e = l as ethers.EventLog; applyPublished(e.args[0], e.args[1], e.args[2], e.args[3], e.args[4]); changed = true; }
              for (const l of s) { const e = l as ethers.EventLog; applySolved(e.args[0], e.args[1]); changed = true; }
              for (const l of t) { const e = l as ethers.EventLog; applySettled(e.args[0], e.args[1], e.args[2]); changed = true; }
              if (changed) flush();
              lastPolled = latest;
            }
          } catch { /* retry */ }
          if (!stopped) setTimeout(poll, 2000);
        };
        setTimeout(poll, 2000);
      } catch (e) {
        setError(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    init();
    return () => { stopped = true; };
  }, []);

  const topWorkers = Array.from(stats.workerEarnings.entries())
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, 10);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-800">
        <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          Home
        </Link>
        <div className="text-sm font-medium text-gray-500">A2A IntentPool Protocol</div>
        <a href={`${EXPLORER_BASE}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noopener noreferrer"
          className="text-xs text-gray-600 hover:text-purple-400 font-mono transition-colors">
          {CONTRACT_ADDRESS.substring(0, 8)}...{CONTRACT_ADDRESS.slice(-6)}
        </a>
      </nav>

      <div className="max-w-7xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Protocol Explorer</h1>
            <div className="flex items-center gap-4 mt-2">
              <p className="text-gray-400 flex items-center text-sm">
                <span className={`inline-block w-2.5 h-2.5 rounded-full mr-2 ${isConnected ? "bg-green-500 animate-pulse" : "bg-yellow-500"}`} />
                {isConnected ? "Connected to Monad Testnet" : "Connecting..."}
              </p>
              {lastUpdated && <p className="text-gray-600 text-xs">Updated: {lastUpdated.toLocaleTimeString()}</p>}
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 bg-red-900/60 border border-red-700 rounded text-red-300 text-sm">{error}</div>
        )}

        {/* ── Protocol Dashboard ─────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="TVL (Locked)" value={`${Number(ethers.formatEther(stats.tvl)).toFixed(4)} MON`} sub="Active bounties in escrow" accent="text-green-400" />
          <StatCard label="Total Intents" value={String(stats.totalIntents)} sub={`${stats.settledCount} settled`} />
          <StatCard label="Active Workers" value={String(stats.activeWorkers.size)} sub="Unique solver addresses" accent="text-blue-400" />
          <StatCard label="Active Employers" value={String(stats.activeEmployers.size)} sub="Unique requester addresses" accent="text-purple-400" />
        </div>

        {/* ── Leaderboard + Intent Table ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">

          {/* Leaderboard */}
          <div className="lg:col-span-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-sm font-medium text-gray-300">Top Workers (by Earnings)</h2>
            </div>
            {topWorkers.length === 0 ? (
              <div className="px-5 py-8 text-center text-gray-600 text-xs">No settled intents yet</div>
            ) : (
              <ul className="divide-y divide-gray-800/50">
                {topWorkers.map(([addr, earned], i) => (
                  <li key={addr} className="px-5 py-3 flex items-center gap-3">
                    <span className={`text-xs font-bold w-5 text-center ${i === 0 ? "text-yellow-400" : i === 1 ? "text-gray-400" : i === 2 ? "text-orange-400" : "text-gray-600"}`}>
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <a href={`${EXPLORER_BASE}/address/${addr}`} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-xs text-gray-400 hover:text-purple-400 transition-colors truncate block">
                        {addr.substring(0, 8)}...{addr.slice(-4)}
                      </a>
                    </div>
                    <span className="text-xs text-green-400 font-medium whitespace-nowrap">
                      {Number(ethers.formatEther(earned)).toFixed(4)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Intent Table */}
          <div className="lg:col-span-3 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">Intent Feed</h2>
              <span className="text-xs text-gray-500">{intents.length} records</span>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="text-gray-400 text-xs uppercase tracking-wider">
                <tr className="bg-gray-800/40">
                  <th className="px-6 py-3 font-medium">Intent ID</th>
                  <th className="px-6 py-3 font-medium">Task Type</th>
                  <th className="px-6 py-3 font-medium">Employer</th>
                  <th className="px-6 py-3 font-medium">Bounty (MON)</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {intents.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-14 text-center text-gray-600">
                      <div className="flex flex-col items-center gap-2">
                        <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        <span>No active intents — waiting for an Employer Agent to broadcast...</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  intents.map((intent) => (
                    <tr key={intent.id} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center font-mono text-blue-400 text-xs">
                          <span title={intent.id}>{intent.id.substring(0, 14)}...</span>
                          <CopyButton text={intent.id} />
                        </div>
                      </td>
                      <td className="px-6 py-4 text-gray-300">
                        <span className="px-2 py-0.5 bg-gray-800 rounded text-xs font-mono">{intent.taskType}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1 font-mono text-gray-400 text-xs">
                          <a href={`${EXPLORER_BASE}/address/${intent.employer}`} target="_blank" rel="noopener noreferrer"
                            className="hover:text-purple-400 transition-colors" title={intent.employer}>
                            {intent.employer.substring(0, 8)}...{intent.employer.slice(-4)}
                          </a>
                          <CopyButton text={intent.employer} />
                        </div>
                      </td>
                      <td className="px-6 py-4 text-green-400 font-medium text-sm">{intent.bounty}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                          intent.status === "Pending"
                            ? "bg-yellow-900/40 text-yellow-300 border border-yellow-800"
                            : intent.status === "Solved"
                            ? "bg-blue-900/40 text-blue-300 border border-blue-800"
                            : "bg-green-900/40 text-green-300 border border-green-800"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            intent.status === "Pending" ? "bg-yellow-400 animate-pulse" :
                            intent.status === "Solved"  ? "bg-blue-400" : "bg-green-400"
                          }`} />
                          {intent.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
