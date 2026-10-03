/** SQLite driver shim: node:sqlite under Node (tests, standalone), bun:sqlite under Bun (inside the LITTO server). Same tiny surface either way. */
export type Stmt = { all(...p: any[]): any[]; get(...p: any[]): any; run(...p: any[]): { changes: number | bigint } };
export type SqliteDb = { exec(sql: string): void; prepare(sql: string): Stmt };

export async function openSqlite(file: string): Promise<SqliteDb> {
    if (typeof (globalThis as any).Bun !== "undefined") {
        const { Database } = await import(/* @vite-ignore */ "bun:" + "sqlite");
        const d = new Database(file);
        return {
            exec: (s: string) => void d.exec(s),
            prepare: (s: string) => {
                const st = d.prepare(s);
                // bun returns null for "no row"; node returns undefined — normalise.
                return { all: (...p: any[]) => st.all(...p), get: (...p: any[]) => st.get(...p) ?? undefined, run: (...p: any[]) => st.run(...p) };
            },
        };
    }
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file) as unknown as SqliteDb;
}
