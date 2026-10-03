import { Hono } from "hono";

// Owned by the nle feature. Mounted in app.ts behind authentication.
export const nle = new Hono();
