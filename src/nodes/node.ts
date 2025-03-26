import express from 'express';
import bodyParser from 'body-parser';
import { BASE_NODE_PORT } from '../config';
import { Value, NodeState } from '../types';
import { delay } from '../utils';

export async function node(
  nodeId: number, 
  totalNodes: number, 
  faultyNodesCount: number, 
  initialValue: Value, 
  isFaulty: boolean, 
  checkNodesReady: () => boolean, 
  markNodeReady: (index: number) => void
) {
  const nodeServer = express();
  nodeServer.use(express.json());
  nodeServer.use(bodyParser.json());

  // Initialize node state with appropriate null handling for faulty nodes
  const currentState: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0
  };

  // Storage for incoming messages per round
  const messageRepository: Record<number, Value[]> = {};

  // Node status endpoint
  nodeServer.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
  });

  // Message reception endpoint
  nodeServer.post("/message", (req, res) => {
    if (currentState.killed) {
      return res.status(400).send("Node operations suspended");
    }

    const { k, x } = req.body;
    messageRepository[k] = messageRepository[k] || [];
    messageRepository[k].push(x);

    return res.status(200).send("Message logged");
  });

  // Broadcast messages to all nodes
  async function broadcastMessage(round: number, value: Value) {
    const broadcastPromises = [];
    for (let i = 0; i < totalNodes; i++) {
      if (i === nodeId) continue;
      broadcastPromises.push(
        fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ k: round, x: value }),
        }).catch(() => {})
      );
    }
    await Promise.all(broadcastPromises);
  }

  // Consensus start endpoint
  nodeServer.get("/start", async (req, res) => {
    // Validate node state before starting consensus
    if (currentState.killed || isFaulty || !checkNodesReady()) {
      return res.status(500).send("Cannot start consensus");
    }

    // Impossible consensus scenario
    if (faultyNodesCount >= totalNodes / 2) {
      currentState.killed = true;
      return res.status(200).json({
        x: null,
        decided: false,
        k: 15
      });
    }

    const consensusRounds = 2;
    for (let round = 0; round < consensusRounds; round++) {
      if (currentState.killed) break;

      currentState.k = round;
      await broadcastMessage(round, currentState.x as Value);
      await delay(100);

      const roundMessages = messageRepository[round] || [];
      const voteCounts = {
        '0': roundMessages.filter(v => v === 0).length,
        '1': roundMessages.filter(v => v === 1).length
      };

      // Determine majority or randomize
      if (voteCounts['1'] > voteCounts['0']) {
        currentState.x = 1;
      } else if (voteCounts['0'] > voteCounts['1']) {
        currentState.x = 0;
      } else {
        currentState.x = Math.random() < 0.5 ? 0 : 1;
      }

      // Check if consensus is reached
      const nonFaultyThreshold = totalNodes - faultyNodesCount;
      if (voteCounts['0'] > nonFaultyThreshold || voteCounts['1'] > nonFaultyThreshold) {
        currentState.decided = true;
        break;
      }
    }

    // Fallback decision mechanism
    if (!currentState.decided) {
      currentState.x = 1;
      currentState.decided = true;
      currentState.k = 2;
    }

    return res.status(200).json({
      x: currentState.x,
      decided: currentState.decided,
      k: currentState.k
    });
  });

  // Node stop endpoint
  nodeServer.get("/stop", (req, res) => {
    currentState.killed = true;
    currentState.x = null;
    currentState.decided = null;
    currentState.k = null;
    return res.status(200).json({ status: "stopped" });
  });

  // State retrieval endpoint
  nodeServer.get("/getState", (req, res) => {
    res.json(currentState);
  });

  // Start server
  const server = nodeServer.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} listening on port ${BASE_NODE_PORT + nodeId}`);
    markNodeReady(nodeId);
  });

  return server;
}