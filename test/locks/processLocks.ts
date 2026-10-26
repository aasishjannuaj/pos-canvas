// Batch B — TEST-ONLY Web Locks model with killable "processes".
//
// Node 24 ships a real navigator.locks, but it is one per OS process: a test
// that simulates a tab or process DYING mid-submission (a promise that never
// settles) would leave that lock held forever, which no browser does — the
// browser releases every lock of a tab when it dies. This registry follows the
// Web Locks rules this code depends on (exclusive mode, FIFO grant order,
// ifAvailable granting null, AbortSignal while waiting, query()) and adds
// kill(): drop every lock and pending request of one simulated process.
//
// It is a MODEL, used only where a test needs to kill a holder. The real
// browser API is exercised by prototype/multitab (real Chromium).
import type { LockManagerLike } from "@/lib/tabLocks";

type Waiter = {
  owner: number;
  name: string;
  grant: () => void;
  cancel: (reason: unknown) => void;
};

export type ProcessLockManager = LockManagerLike & {
  /** Simulated death: release everything this process holds or waits for. */
  kill(): void;
};

export function createLockRegistry() {
  const held = new Map<string, number>(); // name -> owner
  const waiting: Waiter[] = [];
  let nextOwner = 1;

  function pump(name: string) {
    if (held.has(name)) return;
    const index = waiting.findIndex((w) => w.name === name);
    if (index === -1) return;
    const [waiter] = waiting.splice(index, 1);
    held.set(name, waiter.owner);
    waiter.grant();
  }

  function process(): ProcessLockManager {
    const owner = nextOwner++;
    let dead = false;

    return {
      request(name, options, callback) {
        if (dead) return Promise.reject(new DOMException("process is dead", "InvalidStateError"));

        if (options.ifAvailable) {
          if (held.has(name) || waiting.some((w) => w.name === name)) {
            return Promise.resolve(callback(null));
          }
          held.set(name, owner);
          return run(name, callback);
        }

        return new Promise((resolve, reject) => {
          const waiter: Waiter = {
            owner,
            name,
            grant: () => run(name, callback).then(resolve, reject),
            cancel: reject,
          };
          if (options.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          options.signal?.addEventListener("abort", () => {
            const index = waiting.indexOf(waiter);
            if (index !== -1) {
              waiting.splice(index, 1);
              reject(new DOMException("aborted", "AbortError"));
            }
          });
          waiting.push(waiter);
          pump(name);
        });

        function run(lockName: string, cb: (lock: unknown) => unknown) {
          return Promise.resolve()
            .then(() => cb({ name: lockName, mode: "exclusive" }))
            .finally(() => {
              if (held.get(lockName) === owner && !dead) {
                held.delete(lockName);
                pump(lockName);
              }
            });
        }
      },
      async query() {
        return {
          held: [...held.entries()].map(([name]) => ({ name })),
          pending: waiting.map((w) => ({ name: w.name })),
        };
      },
      kill() {
        dead = true;
        for (const [name, holder] of [...held.entries()]) {
          if (holder === owner) {
            held.delete(name);
            pump(name);
          }
        }
        for (const waiter of [...waiting]) {
          if (waiter.owner === owner) {
            waiting.splice(waiting.indexOf(waiter), 1);
            waiter.cancel(new DOMException("process died", "AbortError"));
          }
        }
      },
    };
  }

  return { process };
}
