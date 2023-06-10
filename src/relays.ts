import { Relay, relayInit, Pub } from "nostr-tools";
import { WebSocket } from "ws";

// @ts-ignore
global.WebSocket = WebSocket;

const relays = new Map<string, Relay>();
export function getRelay(url: string) {
  if (!relays.has(url)) {
    const relay = relayInit(url);
    relays.set(url, relay);

    relay.on("connect", () => {
      console.log(`connected to ${url}`);
    });
    relay.on("disconnect", () => {
      console.log(`disconnect from ${url}`);
    });

    return relay;
  }
  return relays.get(url) as Relay;
}

export async function waitForPub(pub: Pub) {
  return new Promise((res, rej) => {
    pub.on("ok", res);
    pub.on("failed", rej);
  });
}

export async function ensureConnected(relay: Relay) {
  if (relay.status !== WebSocket.OPEN) {
    await relay.connect();
  }
}
