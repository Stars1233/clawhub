import { ConvexHttpClient } from 'convex/browser'
import { ConvexReactClient } from 'convex/react'

export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string)
export const convexHttp = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL as string)
