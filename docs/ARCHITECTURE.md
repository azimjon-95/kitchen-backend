# Architecture

- `apps/client`: cook-facing responsive React application.
- `apps/admin`: administrator interface.
- `apps/server`: REST API and optional MongoDB connection.
- `packages/shared`: shared domain types.

The API can start without MongoDB in foundation stage. Database-backed features are intentionally deferred to stage 3.
