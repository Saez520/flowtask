---
description: Scan and index only API/endpoints layer into Engram
agent: flowtask-initializer
subtask: true
---
Scan the API/endpoints layer of this project:

1. Detect file types:
   - Look for files that define API routes, endpoints, or handlers
   - Common extensions: .ts, .java, .py, .go, .cs, .php, .js

2. Identify API directories:
   - Look for directories with names like: controller, controllers, route, routes, api, endpoints, handler, handlers, resource, resources, router, routers, presenter, presenters

3. Identify API framework:
   - REST APIs: Express, FastAPI, Spring MVC, Flask, Gin, ASP.NET, Laravel
   - GraphQL: Apollo Server, Relay, Nexus
   - gRPC: Protocol buffers
   - WebSocket: socket.io, ws
   - Message queues: consumers, producers, handlers

4. Extract API conventions:
   - URL naming patterns: /users, /user-profiles, /v1/users
   - HTTP method usage: GET, POST, PUT, PATCH, DELETE
   - Request/response structure: JSON bodies, query parameters, headers
   - Status codes usage
   - Error response format
   - Authentication/authorization patterns
   - Middleware usage

5. Save to Engram:
   - mem_save(type: pattern, topic_key: project/api, title: "API/endpoint patterns")
   - mem_save(type: pattern, topic_key: project/naming, title: "Naming conventions") if URL patterns found
   - Use mem_suggest_topic_key before saving

6. Report what was detected and saved.
