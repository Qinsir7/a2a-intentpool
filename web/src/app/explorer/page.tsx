"use client";

import Link from "next/link";
import Image from "next/image";
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
    <button onClick={handleCopy} className="ml-1.5 text-gray-600 hover:text-gray-300 transition-colors" title="Copy">
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      )}
    </button>
  );
}

function StatCard({ label, value, sub, icon, accent = "text-white" }: { label: string; value: string; sub?: string; icon: React.ReactNode; accent?: string }) {
  return (
    <div className="relative rounded-2xl border border-gray-800 bg-gray-900/50 p-6 overflow-hidden group hover:border-gray-700 transition-colors">
      <div className="absolute top-4 right-4 text-gray-800 group-hover:text-gray-700 transition-colors">{icon}</div>
      <span className="text-sm text-gray-500 uppercase tracking-wider font-medium">{label}</span>
      <div className={`text-3xl font-bold tracking-tight mt-2 ${accent}`}>{value}</div>
      {sub && <span className="text-sm text-gray-600 mt-1 block">{sub}</span>}
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

  const statusConfig = {
    Pending:  { bg: "bg-amber-500/10", text: "text-amber-300", border: "border-amber-500/20", dot: "bg-amber-400" },
    Solved:   { bg: "bg-blue-500/10",   text: "text-blue-300",  border: "border-blue-500/20",  dot: "bg-blue-400" },
    Settled:  { bg: "bg-emerald-500/10", text: "text-emerald-300", border: "border-emerald-500/20", dot: "bg-emerald-400" },
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 glass">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/logo-white.png" alt="A2A IntentPool" width={28} height={28} className="rounded" />
            <span className="text-base font-semibold tracking-tight text-white">IntentPool</span>
          </Link>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-sm">
              <span className="relative flex h-2 w-2">
                {isConnected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? "bg-green-500" : "bg-yellow-500"}`} />
              </span>
              <span className="text-gray-400 text-sm hidden sm:inline">{isConnected ? "Monad Testnet" : "Connecting..."}</span>
            </div>
            <a href={`${EXPLORER_BASE}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noopener noreferrer"
              className="text-sm text-gray-600 hover:text-purple-400 font-mono transition-colors hidden sm:inline">
              {CONTRACT_ADDRESS.substring(0, 8)}...{CONTRACT_ADDRESS.slice(-6)}
            </a>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 pt-24 pb-12">
        {/* Header */}
        <div className="mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Intent <span className="bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">Explorer</span>
          </h1>
          <div className="flex items-center gap-4 mt-3">
            {lastUpdated && <p className="text-gray-600 text-sm">Last update: {lastUpdated.toLocaleTimeString()}</p>}
          </div>
        </div>

        {error && (
          <div className="mb-8 px-5 py-4 bg-red-900/20 border border-red-800/40 rounded-xl text-red-300 text-sm flex items-center gap-3">
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {error}
          </div>
        )}

        {/* Protocol Dashboard */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          <StatCard
            label="Active Task Value"
            value={`${Number(ethers.formatEther(stats.tvl)).toFixed(4)}`}
            sub="MON committed to open intents"
            accent="text-emerald-400"
            icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>}
          />
          <StatCard
            label="Total Intents"
            value={String(stats.totalIntents)}
            sub={`${stats.settledCount} completed`}
            icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
          />
          <StatCard
            label="Worker Agents"
            value={String(stats.activeWorkers.size)}
            sub="Unique executor addresses"
            accent="text-blue-400"
            icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" /></svg>}
          />
          <StatCard
            label="Employer Agents"
            value={String(stats.activeEmployers.size)}
            sub="Unique requester addresses"
            accent="text-purple-400"
            icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
          />
        </div>

        {/* Leaderboard + Intent Table */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Leaderboard */}
          <div className="lg:col-span-1">
            <div className="rounded-2xl border border-gray-800 bg-gray-900/50 overflow-hidden sticky top-24">
              <div className="px-6 py-5 border-b border-gray-800">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                  Top Agents
                </h2>
                <p className="text-xs text-gray-600 mt-1">Ranked by tasks completed</p>
              </div>
              {topWorkers.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <svg className="w-10 h-10 text-gray-800 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                  <p className="text-gray-600 text-sm">No settled intents yet</p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-800/50">
                  {topWorkers.map(([addr, earned], i) => {
                    const medal = i === 0 ? "text-yellow-400" : i === 1 ? "text-gray-400" : i === 2 ? "text-orange-400" : "text-gray-700";
                    return (
                      <li key={addr} className="px-6 py-3.5 flex items-center gap-3 hover:bg-gray-800/30 transition-colors">
                        <span className={`text-sm font-bold w-5 text-center ${medal}`}>
                          {i < 3 ? ["1st", "2nd", "3rd"][i] : `${i + 1}`}
                        </span>
                        <div className="flex-1 min-w-0">
                          <a href={`${EXPLORER_BASE}/address/${addr}`} target="_blank" rel="noopener noreferrer"
                            className="font-mono text-sm text-gray-400 hover:text-purple-400 transition-colors truncate block">
                            {addr.substring(0, 10)}...{addr.slice(-4)}
                          </a>
                        </div>
                        <span className="text-sm text-emerald-400 font-semibold tabular-nums">
                          {Number(ethers.formatEther(earned)).toFixed(4)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Intent Feed */}
          <div className="lg:col-span-3">
            <div className="rounded-2xl border border-gray-800 bg-gray-900/50 overflow-hidden">
              <div className="px-6 py-5 border-b border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Intent Feed</h2>
                <span className="text-sm text-gray-600 tabular-nums">{intents.length} records</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800/50">
                      <th className="px-6 py-3.5 font-medium">Intent ID</th>
                      <th className="px-6 py-3.5 font-medium">Task</th>
                      <th className="px-6 py-3.5 font-medium">Employer</th>
                      <th className="px-6 py-3.5 font-medium text-right">Reward</th>
                      <th className="px-6 py-3.5 font-medium text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/30">
                    {intents.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-20 text-center">
                          <div className="flex flex-col items-center gap-3">
                            <div className="w-16 h-16 rounded-2xl bg-gray-800/50 flex items-center justify-center">
                              <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                            </div>
                            <p className="text-gray-600 text-sm">Waiting for intents...</p>
                            <p className="text-gray-700 text-sm max-w-xs">No active intents in the pool. Once an Employer Agent broadcasts a task, it will appear here in real time.</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      intents.map((intent) => {
                        const sc = statusConfig[intent.status];
                        return (
                          <tr key={intent.id} className="hover:bg-gray-800/20 transition-colors">
                            <td className="px-6 py-4">
                              <div className="flex items-center font-mono text-blue-400 text-sm">
                                <a href={`${EXPLORER_BASE}/tx/${intent.id}`} target="_blank" rel="noopener noreferrer"
                                  className="hover:text-blue-300 transition-colors" title={intent.id}>
                                  {intent.id.substring(0, 14)}...
                                </a>
                                <CopyButton text={intent.id} />
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="px-2.5 py-1 bg-gray-800/60 rounded-lg text-sm font-mono text-gray-300">{intent.taskType}</span>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-1 font-mono text-gray-400 text-sm">
                                <a href={`${EXPLORER_BASE}/address/${intent.employer}`} target="_blank" rel="noopener noreferrer"
                                  className="hover:text-purple-400 transition-colors" title={intent.employer}>
                                  {intent.employer.substring(0, 8)}...{intent.employer.slice(-4)}
                                </a>
                                <CopyButton text={intent.employer} />
                              </div>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="text-emerald-400 font-semibold tabular-nums">{intent.bounty}</span>
                              <span className="text-gray-600 text-sm ml-1">MON</span>
                            </td>
                            <td className="px-6 py-4 text-center">
                              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${sc.bg} ${sc.text} border ${sc.border}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${sc.dot} ${intent.status === "Pending" ? "animate-pulse" : ""}`} />
                                {intent.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
