import Koa from "koa";
import { Event, Filter, Kind, nip19 } from "nostr-tools";
import { ensureConnected, getRelay } from "./relays.js";

const app = new Koa({
  subdomainOffset: process.env.NODE_ENV === "development" ? 1 : 2,
});

const defaultRelays = [
  "wss://relay.damus.io",
  "wss://nostr-pub.wellorder.net",
  "wss://e.nos.lol",
];
async function queryRelays(
  filter: Filter,
  relays: string[] = defaultRelays
): Promise<Event<Kind>> {
  const events = await Promise.all(
    relays.map(async (url) => {
      const relay = getRelay(url);
      await ensureConnected(relay);
      return await relay.get(filter);
    })
  );

  return events.filter(Boolean).sort((a, b) => a.created_at - b.created_at)[0];
}

const cache = new Map<string, Event<Kind>>();
async function getEventById(id: string, relays: string[]) {
  if (cache.has(id)) return cache.get(id)!;
  const event = await queryRelays({ ids: [id] }, relays);
  if (event) cache.set(event.id, event);
  return event;
}

function getRelaysFromPointer(decoded: nip19.DecodeResult) {
  switch (decoded.type) {
    case "nevent":
    case "naddr":
      return decoded.data.relays.length === 0
        ? defaultRelays
        : decoded.data.relays;
  }
}

async function resolveEvent(
  pointer: string
): Promise<{ event: Event<number> | undefined; relays: string[] } | undefined> {
  const decoded = nip19.decode(pointer);

  let relays = getRelaysFromPointer(decoded);
  let event: Event;
  switch (decoded.type) {
    case "nevent":
      event = await queryRelays({ ids: [decoded.data.id] }, relays);
      return { event, relays };
    case "naddr":
      event = await queryRelays(
        {
          authors: [decoded.data.pubkey],
          "#d": [decoded.data.identifier],
          kinds: [decoded.data.kind],
        },
        relays
      );
      return { event, relays };
  }
}

app.use(async (ctx) => {
  const respondWithEvent = (event: Event) => {
    ctx.header["nostr-event"] = event.id;
    ctx.header["nsotr-pubkey"] = event.pubkey;

    for (const tag of event.tags) {
      if (tag[0] === "header" && tag.length === 3) {
        ctx.header[tag[1]] = tag[2];
      }
    }

    ctx.body = event.content;
  };

  try {
    const { event, relays } = await resolveEvent(ctx.subdomains[0]);

    if (!event) return (ctx.state = 404);

    if (ctx.path === "/") {
      respondWithEvent(event);
    } else {
      const tag = event.tags.find((t) => t[0] === "e" && t[3] === ctx.path);
      if (!tag) {
        ctx.status = 404;
        ctx.body = `${ctx.path} dose not exist on ${event.id}`;
        return;
      }

      const subEvent = await getEventById(tag[1], relays);
      if (!subEvent) return (ctx.status = 404);

      respondWithEvent(subEvent);
    }
  } catch (e) {
    ctx.status = 500;
    if (e instanceof Error) {
      ctx.body = e.stack;
    }
  }
});

app.listen(3000);

console.log(`Server listening on port 3000`);

async function shutdown() {
  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.once("SIGUSR2", shutdown);
