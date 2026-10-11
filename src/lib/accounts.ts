import { randomUUID } from "crypto";
import { kvGet, kvSet } from "./store";

export interface Account {
  id: string;
  name: string;
  createdAt: number;
}

const KEY = "accounts";

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

export async function createAccount(name: string): Promise<Account> {
  const accounts = await read();
  const account: Account = {
    id: randomUUID(),
    name: name.trim() || `Account ${accounts.length + 1}`,
    createdAt: Date.now(),
  };
  accounts.push(account);
  await write(accounts);
  return account;
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
  const accounts = await read();
  await write(accounts.filter((x) => x.id !== id));
}

export async function accountExists(id: string): Promise<boolean> {
  return (await read()).some((x) => x.id === id);
}
