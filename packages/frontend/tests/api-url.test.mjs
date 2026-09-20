import assert from "node:assert/strict"
import test from "node:test"
import axios from "axios"
import { showcaseRoutes } from "../lib/api-routes.ts"

const api = axios.create({ baseURL: "http://localhost:3100/api" })

test("showcase requests use the shared API base path exactly once", () => {
  const url = api.getUri({ url: showcaseRoutes.list })

  assert.equal(url, "http://localhost:3100/api/v1/showcase/tasks")
})
