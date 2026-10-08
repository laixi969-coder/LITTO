import axios from "axios";
import { storyProjectSchema, type StoryAction } from "@toonflow/tool-scene-list/storyProject";

const client = axios.create({ baseURL: "/api/story", headers: { "x-toonflow-workspace": "1" } });
export async function readStory(directory: string) {
  return storyProjectSchema.parse((await client.get("/get", { params: { directory } })).data.data);
}
export async function updateStory(directory: string, expectedVersion: number, action: StoryAction) {
  return storyProjectSchema.parse((await client.post("/apply", { directory, expectedVersion, action })).data.data);
}
