import type { WatchLogStoreApi } from "../types";
import type { ReadingStore } from "../domains/reading/store";

export interface ApiRequest { method: string; path: string; query: Record<string, string>; body: unknown; remote: boolean }
export interface ApiResponse { status: number; body: unknown }
export interface ApiDeps { store: WatchLogStoreApi; reading: ReadingStore; version: string; revision: () => number; now: () => Date }
export type RouteHandler = (req: ApiRequest, deps: ApiDeps) => Promise<ApiResponse | undefined> | ApiResponse | undefined;
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
