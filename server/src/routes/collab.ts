import { Hono } from "hono";

// Owned by the collab feature. Mounted in app.ts behind authentication.
export const collab = new Hono();
