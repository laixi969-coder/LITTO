import { Hono } from "hono";

// Owned by the sso feature. Mounted in app.ts behind authentication.
export const sso = new Hono();
