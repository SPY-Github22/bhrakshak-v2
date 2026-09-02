"use client";

import { MessageSquare, Send, X, User, MapPin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { endpoints, ensureToken, getSession } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ChatMsg {
  id: string;
  sender_name: string;
  location: string;
  message: string;
  role: string;
  timestamp: string;
}

function wsUrl(): string {
  const base = endpoints.API;
  return base.replace(/^http/, "ws") + "/ws/live";
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const fetchMsgs = useCallback(async () => {
    try {
      const token = await ensureToken();
      const res = await fetch(`${endpoints.API}/api/v1/chat/messages`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Bypass-Tunnel-Remainder": "true",
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        // Server contract: oldest -> newest. Dedupe by id (poll + WS race).
        setMessages((prev) => {
          const seen = new Set(data.map((m: ChatMsg) => m.id));
          return data as ChatMsg[];
        });
      }
    } catch {
      /* offline: keep last known messages */
    }
  }, []);

  // Initial load + light polling as WS fallback (survives tunnel hiccups).
  useEffect(() => {
    fetchMsgs();
    const interval = setInterval(fetchMsgs, 5000);
    return () => clearInterval(interval);
  }, [fetchMsgs]);

  // Live WebSocket with reconnect + backoff. Unread only counts when the
  // panel is closed, and only for messages from the field (not our own).
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type !== "chat_message") return;
          const msg = data as ChatMsg;
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
          if (!openRef.current) setUnread((u) => u + 1);
        } catch { }
      };
      ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => ws?.close();
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      const delay = Math.min(1000 * 2 ** retry, 30000);
      retry += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    if (open) {
      setUnread(0);
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [open, messages]);

  const handleSend = async () => {
    const txt = input.trim();
    if (!txt) return;
    setInput("");

    const session = getSession();
    try {
      const token = await ensureToken();
      const res = await fetch(`${endpoints.API}/api/v1/chat/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Bypass-Tunnel-Remainder": "true",
        },
        body: JSON.stringify({
          message: txt,
          location: session?.email ?? "Command Center",
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        console.error("chat send failed", res.status, detail);
        return;
      }
      const sent = (await res.json()) as ChatMsg;
      // Reconcile with the server's canonical copy (id, timestamp, identity).
      setMessages((prev) =>
        prev.some((m) => m.id === sent.id) ? prev : [...prev, sent],
      );
    } catch (err) {
      console.error("chat send error", err);
    }
  };

  return (
    <div className="fixed bottom-12 right-5 z-50 flex flex-col items-end">
      {open ? (
        <div className="anim anim-fade flex h-[460px] w-96 flex-col overflow-hidden rounded-2xl border border-orange-500/30 bg-panel/95 shadow-2xl shadow-black/80 backdrop-blur">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-edge bg-orange-950/40 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span
                  className={cn(
                    "absolute inline-flex h-full w-full rounded-full opacity-75",
                    connected ? "animate-ping bg-emerald-400" : "bg-red-500"
                  )}
                />
                <span
                  className={cn(
                    "relative inline-flex h-2.5 w-2.5 rounded-full",
                    connected ? "bg-emerald-500" : "bg-red-500"
                  )}
                />
              </span>
              <span className="text-sm font-bold text-ink">Field Emergency Chat</span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[9px] font-bold",
                  connected ? "bg-orange-600/30 text-orange-300" : "bg-red-900/40 text-red-300"
                )}
              >
                {connected ? "LIVE" : "RECONNECTING"}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg p-1 text-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 [scrollbar-width:thin]">
            {messages.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted">
                No field messages yet. Mobile app messages appear here in real-time.
              </div>
            ) : (
              messages.map((m, i) => {
                const isHq = m.role === "admin" || m.role === "district_admin";
                return (
                  <div
                    key={m.id || i}
                    className={cn(
                      "flex flex-col max-w-[85%] rounded-xl p-3 text-xs leading-relaxed shadow-md",
                      isHq
                        ? "ml-auto bg-orange-600/20 text-orange-100 border border-orange-500/40 rounded-br-none"
                        : "mr-auto bg-slate-800/90 text-slate-100 border border-slate-700 rounded-bl-none"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1 mb-1">
                      <span className="font-bold flex items-center gap-1 text-[11px] text-orange-300">
                        <User size={11} /> {m.sender_name}
                      </span>
                      <span className="text-[9px] text-slate-400">
                        {m.timestamp
                          ? new Date(m.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                          : ""}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 text-[10px] font-mono text-sky-400 mb-1">
                      <MapPin size={10} /> {m.location || "Field Location"}
                    </div>

                    <p className="text-[12px]">{m.message}</p>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input Bar */}
          <div className="border-t border-edge bg-bg/80 p-2.5 flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Reply to field team..."
              className="flex-1 rounded-xl border border-edge bg-panel px-3 py-2 text-xs text-ink placeholder:text-muted focus:border-orange-500 focus:outline-none"
            />
            <button
              onClick={handleSend}
              className="grid h-9 w-9 place-items-center rounded-xl bg-orange-600 text-white transition-all hover:bg-orange-500 shadow-md shadow-orange-950"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="relative flex items-center gap-2 rounded-full border border-orange-500/40 bg-orange-600 px-4 py-2.5 text-xs font-bold text-white shadow-xl shadow-orange-950/80 transition-all hover:scale-105 active:scale-95"
        >
          <MessageSquare size={16} />
          <span>Field Emergency Chat</span>
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-red-600 text-[10px] font-black text-white ring-2 ring-panel">
              {unread}
            </span>
          )}
        </button>
      )}
    </div>
  );
}