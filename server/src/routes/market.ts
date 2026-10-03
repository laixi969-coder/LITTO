import { Hono } from "hono";

// Owned by the market feature. Mounted in app.ts behind authentication.
export const market = new Hono();
