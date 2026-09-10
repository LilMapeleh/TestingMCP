import { pathToFileURL } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { rateLimit } from "express-rate-limit";
import { z } from "zod/v4";
const DEFAULT_PORT = 3000;
const DEFAULT_RATE_LIMIT = 120;
function parseList(value) {
    return (value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean) ?? []);
}
function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function getAzureHosts() {
    const appName = process.env.CONTAINER_APP_NAME;
    const dnsSuffix = process.env.CONTAINER_APP_ENV_DNS_SUFFIX;
    const revisionHost = process.env.CONTAINER_APP_HOSTNAME;
    const stableHost = appName && dnsSuffix ? `${appName}.${dnsSuffix}` : undefined;
    return [stableHost, revisionHost].filter((host) => Boolean(host));
}
function getRuntimeOptions() {
    const azureHosts = getAzureHosts();
    const port = parsePositiveInteger(process.env.PORT, DEFAULT_PORT);
    const isAzure = azureHosts.length > 0;
    return {
        host: process.env.HOST ?? (isAzure ? "0.0.0.0" : "127.0.0.1"),
        allowedHosts: [
            "localhost",
            "127.0.0.1",
            "[::1]",
            ...azureHosts,
            ...parseList(process.env.MCP_ALLOWED_HOSTS),
        ],
        allowedOrigins: [
            `http://localhost:${port}`,
            `http://127.0.0.1:${port}`,
            ...azureHosts.map((host) => `https://${host}`),
            ...parseList(process.env.MCP_ALLOWED_ORIGINS),
        ],
        rateLimit: parsePositiveInteger(process.env.MCP_RATE_LIMIT, DEFAULT_RATE_LIMIT),
    };
}
async function fetchJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`Joke API request failed with status ${response.status}`);
    }
    return response.json();
}
function getStringProperty(data, property) {
    if (typeof data !== "object" ||
        data === null ||
        !(property in data) ||
        typeof data[property] !== "string") {
        throw new Error(`Joke API response is missing '${property}'`);
    }
    return data[property];
}
export function buildServer() {
    const server = new McpServer({
        name: "mcp-streamable-http",
        version: "1.0.0",
    });
    server.registerTool("get-chuck-joke", { description: "Get a random Chuck Norris joke" }, async () => {
        const data = await fetchJson("https://api.chucknorris.io/jokes/random");
        return {
            content: [{ type: "text", text: getStringProperty(data, "value") }],
        };
    });
    server.registerTool("get-chuck-joke-by-category", {
        description: "Get a random Chuck Norris joke by category",
        inputSchema: z.object({
            category: z.string().describe("Category of the Chuck Norris joke"),
        }),
    }, async ({ category }) => {
        const url = new URL("https://api.chucknorris.io/jokes/random");
        url.searchParams.set("category", category);
        const data = await fetchJson(url);
        return {
            content: [{ type: "text", text: getStringProperty(data, "value") }],
        };
    });
    server.registerTool("get-chuck-categories", { description: "Get all available categories for Chuck Norris jokes" }, async () => {
        const data = await fetchJson("https://api.chucknorris.io/jokes/categories");
        if (!Array.isArray(data) ||
            !data.every((item) => typeof item === "string")) {
            throw new Error("Joke API returned an invalid category list");
        }
        return { content: [{ type: "text", text: data.join(", ") }] };
    });
    server.registerTool("get-dad-joke", { description: "Get a random dad joke" }, async () => {
        const data = await fetchJson("https://icanhazdadjoke.com/", {
            headers: { Accept: "application/json" },
        });
        return {
            content: [{ type: "text", text: getStringProperty(data, "joke") }],
        };
    });
    return server;
}
export function createApp(options = {}) {
    const runtime = getRuntimeOptions();
    const host = options.host ?? runtime.host;
    const allowedHosts = options.allowedHosts ?? runtime.allowedHosts;
    const allowedOrigins = options.allowedOrigins ?? runtime.allowedOrigins;
    const requestLimit = options.rateLimit ?? runtime.rateLimit;
    const app = createMcpExpressApp({ host, allowedHosts });
    if (getAzureHosts().length > 0) {
        app.set("trust proxy", 1);
    }
    app.use("/mcp", (req, res, next) => {
        const origin = req.headers.origin;
        if (!origin) {
            next();
            return;
        }
        let parsedOrigin;
        try {
            parsedOrigin = new URL(origin).origin;
        }
        catch {
            parsedOrigin = "null";
        }
        if (origin === "null" ||
            parsedOrigin !== origin ||
            !allowedOrigins.includes(origin)) {
            res.status(403).json({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Invalid Origin header" },
                id: null,
            });
            return;
        }
        next();
    });
    app.use("/mcp", rateLimit({
        windowMs: 60_000,
        limit: requestLimit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
    }));
    app.post("/mcp", async (req, res) => {
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        res.on("close", () => {
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error("Error handling MCP request:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });
    app.all("/mcp", (_req, res) => {
        res
            .set("Allow", "POST")
            .status(405)
            .json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
        });
    });
    return app;
}
export function startServer() {
    const port = parsePositiveInteger(process.env.PORT, DEFAULT_PORT);
    const options = getRuntimeOptions();
    const app = createApp(options);
    return app.listen(port, options.host, () => {
        console.log(`MCP Streamable HTTP server listening on ${options.host}:${port}`);
    });
}
const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
    startServer();
}
