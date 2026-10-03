import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import StudioLayout from "@/layouts/studio-layout";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";
import StudioAdmin from "@/pages/studio/admin";
import StudioLogin from "@/pages/studio/login";
import StudioProjects from "@/pages/studio/projects";
import StudioSettings from "@/pages/studio/settings";
import StudioSkills from "@/pages/studio/skills";
import StudioWorkbench from "@/pages/studio/workbench";

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    { path: "/studio/login", element: <StudioLogin /> },
    {
        element: <StudioLayout />,
        children: [
            { path: "/studio", element: <StudioProjects /> },
            { path: "/studio/p/:pid", element: <StudioWorkbench /> },
            { path: "/studio/settings", element: <StudioSettings /> },
            { path: "/studio/skills", element: <StudioSkills /> },
            { path: "/studio/admin", element: <StudioAdmin /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
