import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";
import { delay } from "../utils";

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  const state = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  const messagesPhase1: Record<number, { value: Value; from: number }[]> = {};
  const messagesPhase2: Record<number, { value: Value; from: number }[]> = {};

  let isConsensusRunning = false;

  app.get("/status", (req, res) => {
    isFaulty ? res.status(500).send("faulty") : res.status(200).send("live");
  });

  app.post("/message", (req, res) => {
    if (state.killed || isFaulty) {
      return res.status(500).json({ error: "Node is dead or faulty" });
    }

    const { phase, value, k, from } = req.body;
    const target = phase === 1 ? messagesPhase1 : messagesPhase2;

    if (!target[k]) target[k] = [];
    target[k].push({ value, from });

    return res.status(200).json({ success: true });
  });

  app.get("/start", async (req, res) => {
    if (isFaulty || state.killed) {
      return res.status(500).json({ error: "Node is faulty or killed" });
    }

    if (!isConsensusRunning) {
      isConsensusRunning = true;
      runConsensus();
    }

    return res.status(200).json({ success: true });
  });

  app.get("/stop", async (req, res) => {
    state.killed = true;
    isConsensusRunning = false;
    res.status(200).json({ success: true });
  });

  app.get("/getState", (req, res) => {
    res.status(200).json(state);
  });

  async function runConsensus() {
    if (N === 1 && !isFaulty) {
      state.decided = true;
      return;
    }

    while (!state.decided && !state.killed) {
      await phase1();
      await phase2();
      if (!state.decided && !state.killed) state.k = (state.k as number) + 1;
      await delay(10);
    }
  }

  async function phase1() {
    if (state.killed || state.decided) return;
    await sendToAll(1, state.x as Value, state.k as number);
    await waitFor(1);
    handlePhase1();
    messagesPhase1[state.k as number] = []; // Clear messages after use
  }

  async function phase2() {
    if (state.killed || state.decided) return;
    await sendToAll(2, state.x as Value, state.k as number);
    await waitFor(2);
    handlePhase2();
    messagesPhase2[state.k as number] = []; // Clear messages after use
  }

  async function sendToAll(phase: number, value: Value, k: number) {
    const tasks = [];
    for (let i = 0; i < N; i++) {
      if (i === nodeId) continue;
      tasks.push(
        fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase, value, k, from: nodeId }),
        }).catch(() => {})
      );
    }
    await Promise.all(tasks);
  }

  async function waitFor(phase: number) {
    const timeout = 200;
    const start = Date.now();
    const store = phase === 1 ? messagesPhase1 : messagesPhase2;
    const round = state.k as number;

    while (Date.now() - start < timeout && (!store[round] || store[round].length < N - F)) {
      await delay(10);
      if (state.killed) return;
    }
  }

  function handlePhase1() {
    if (state.killed) return;
    const round = state.k as number;
    const received = messagesPhase1[round] || [];

    const count: Record<string, number> = { "0": 0, "1": 0 };
    if (state.x === 0 || state.x === 1) count[state.x.toString()]++;
    for (const { value } of received) if (value === 0 || value === 1) count[value.toString()]++;

    const majority = Math.floor(N / 2) + 1;
    if (count["0"] >= majority) state.x = 0;
    else if (count["1"] >= majority) state.x = 1;
    else state.x = "?";
  }

  function handlePhase2() {
    if (state.killed) return;
    const round = state.k as number;
    const received = messagesPhase2[round] || [];

    const count: Record<string, number> = { "0": 0, "1": 0, "?": 0 };
    if (state.x !== null) count[state.x.toString()]++;
    for (const { value } of received) {
      if (["0", "1", "?"].includes(value.toString())) {
        count[value.toString()]++;
      }
    }

    const nonFaulty = N - F;
    const decisionT = Math.floor(nonFaulty / 2) + 1;
    const adoptionT = Math.floor(nonFaulty / 3) + 1;

    if (count["0"] >= decisionT && state.x === 0) {
      state.decided = true;
    } else if (count["1"] >= decisionT && state.x === 1) {
      state.decided = true;
    } else if (count["0"] >= adoptionT) {
      state.x = 0;
    } else if (count["1"] >= adoptionT) {
      state.x = 1;
    } else {
      state.x = Math.random() < 0.5 ? 0 : 1;
    }
  }

  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}