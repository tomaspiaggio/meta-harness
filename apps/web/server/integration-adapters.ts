// Composition root: adapters remain cold until explicitly discovered or called.
import "./mcp-integrations";

// Control-process infrastructure composition; no adapter or credentials enter agent workers.
import "./google-integrations";
