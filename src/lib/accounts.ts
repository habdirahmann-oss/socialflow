import { randomUUID } from "crypto";
import { kvGet, kvSet, kvUpdate } from "./store";

export interface Account {
  id: string;
  name: string;
  createdAt: number;
}

const KEY = "accounts";

/** Maximaal aantal klantaccounts (server-side afgedwongen). */
export const MAX_ACCOUNTS = 10;
export const MAX_ACCOUNTS_ERROR = "Maximaal 10 klantaccounts";

export class AccountLimitError extends Error {
  constructor() {
    super(MAX_ACCOUNTS_ERROR);
    this.name = "AccountLimitError";
  }
}

async function read(): Promise<Account[]> {
  return (await kvGet<Account[]>(KEY)) ?? [];
}

async function write(accounts: Account[]): Promise<void> {
  await kvSet(KEY, accounts);
}

/** Geeft de accounts terug; maakt automatisch "Account 1" als er nog geen zijn. */
export async function listAccounts(): Promise<Account[]> {
  let accounts = await read();
  if (accounts.length === 0) {
    accounts = [{ id: randomUUID(), name: "Account 1", createdAt: Date.now() }];
    await write(accounts);
  }
  return accounts;
}

/** Maakt een account aan; gooit AccountLimitError bij meer dan MAX_ACCOUNTS. */
export async function createAccount(name: string): Promise<Account> {
  let account: Account | undefined;
  // onder lock, zodat twee gelijktijdige aanvragen de limiet niet omzeilen
  await kvUpdate<Account[]>(KEY, (cur) => {
    const accounts = Array.isArray(cur) ? cur : [];
    if (accounts.length >= MAX_ACCOUNTS) throw new AccountLimitError();
    account = {
      id: randomUUID(),
      name: name.trim().slice(0, 80) || `Account ${accounts.length + 1}`,
      createdAt: Date.now(),
    };
    accounts.push(account);
    return accounts;
  });
  return account!;
}

export async function renameAccount(
  id: string,
  name: string,
): Promise<void> {
  const accounts = await read();
  const a = accounts.find((x) => x.id === id);
  if (a) {
    a.name = name.trim() || a.name;
    await write(accounts);
  }
}

export async function deleteAccount(id: string): Promise<void> {
  await kvUpdate<Account[]>(KEY, (cur) =>
    (Array.isArray(cur) ? cur : []).filter((x) => x.id !== id),
  );
}

export async function accountExists(id: string): Promise<boolean> {
  return (await read()).some((x) => x.id === id);
}
