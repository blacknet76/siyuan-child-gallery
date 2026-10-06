// PUBLIC-safe rules only: no developer/user identity dataset or derived fingerprints.
export function publicPathIssues(name) {
    const parts = name.toLowerCase().split(/[\\/]/);
    const forbidden =
        /^(?:\.git|node_modules|dist|build|dev-evidence|tools|tasks|\.env(?:\..*)?|\.npmrc|\.ds_store|thumbs\.db|\.eslintcache|\.dprint|\.idea|\.vscode|\.codex|\.claude)$/;
    return parts.some(part => forbidden.test(part)) || /(?:\.bak|\.tmp|\.log)$/.test(name) ||
            /^(?:index\.(?:js|css)|kernel\.js|package\.zip)$/.test(name) ?
        ["forbidden local/development artifact path"] :
        [];
}

const rules = [
    ["local profile/environment path", /\/(?:Users|home|Volumes|var|mnt)\/|[a-z]:[\\/]+Users[\\/]/i],
    ["local file URL", /file:\/\//i],
    ["private IPv4 address", /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
    ["credential-bearing URL", /https?:\/\/[^\s/"'<>:]+:[^\s/"'<>@]+@/i],
    ["authentication query", /[?&](?:token|api[_-]?key|password|secret|auth)=/i],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
    [
        "credential token",
        /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]{20,})\b/i,
    ],
    ["credential assignment", /(?:api[_-]?key|password|client[_-]?secret|token)\s*[=:]\s*["'][^"'\r\n]{16,}["']/i],
];
export function privacyIssues(text) {
    const issues = [];
    for (const [label, pattern] of rules) {
        if (pattern.test(text)) issues.push(label);
    }
    return issues;
}

// Source-only exception: the exact existing synthetic negative fixture, never package output.
export function sourcePrivacyIssues(file, text) {
    const fixture = JSON.stringify(["file:", "", "", "tmp", "example-project", "image.png"].join("/")) + ",";
    return [
        ...publicPathIssues(file),
        ...text.split(/\r?\n/).flatMap(line => {
            const exempt = file === "tests/foundation.test.mjs" && line.trim() === fixture;
            return privacyIssues(line).filter(issue => !(exempt && issue === "local file URL"));
        }),
    ];
}
