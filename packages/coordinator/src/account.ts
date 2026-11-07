import { SIGNED_OUT, type AccountPage, type AccountState } from "@arke-studio/contracts";

/**
 * The Arke account behind the chrome's control (design turn 151).
 *
 * The coordinator owns the state and the client renders it, the way vendor sign-in works
 * (SPEC-030): the client sends the frames, the service moves, `onChange` becomes the
 * `account.changed` event every connected client sees. Sign-in is a browser handoff — the
 * service opens the cloud's page through the host's `openExternal` and waits for it to come
 * back — so nothing here ever sees a password, and nothing in the renderer ever sees a token.
 *
 * `NoArkeCloud` remains the local default (SPEC-025). A configured desktop supplies the
 * AONIK creator adapter through `CoordinatorOptions.account`; absent configuration never
 * prevents local authoring, generation or export.
 */
export interface AccountService {
  /** What the next snapshot carries. */
  current(): AccountState;
  /** Cancel and drain a host-owned browser handoff at shutdown. */
  stop?(): Promise<void>;
  /** Begin the handoff. Resolves once the state has moved, never once the browser has answered. */
  signIn(): Promise<void>;
  createAccount(): Promise<void>;
  /** Take back a handoff still waiting on the browser, or clear the refusal a rejected one left. */
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Put one of the account's own pages in the system browser. */
  open(page: AccountPage): Promise<void>;
  /** Every change, after it has happened. */
  onChange(listener: (state: AccountState) => void): () => void;
}

/** What a press on either door answers while there is no cloud — one clause, on the thing refused. */
export const NO_CLOUD_YET = "Arke cloud is not available yet";

export class NoArkeCloud implements AccountService {
  constructor(private readonly refusal = NO_CLOUD_YET) {}
  private state: AccountState = SIGNED_OUT;
  private readonly listeners = new Set<(state: AccountState) => void>();

  current(): AccountState {
    return this.state;
  }

  async signIn(): Promise<void> {
    this.move({ kind: "signed-out", refusal: this.refusal });
  }

  async createAccount(): Promise<void> {
    this.move({ kind: "signed-out", refusal: this.refusal });
  }

  async cancelSignIn(): Promise<void> {
    this.move(SIGNED_OUT);
  }

  async signOut(): Promise<void> {
    this.move(SIGNED_OUT);
  }

  async open(_page: AccountPage): Promise<void> {
    /* no cloud, no page: nothing to open, and no client reaches this door while signed out */
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private move(next: AccountState): void {
    // A second press on a refused door is the same refusal; saying it again would flash the line.
    if (next.kind === "signed-out" && this.state.kind === "signed-out" && next.refusal === this.state.refusal) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
