# 0.5.4 verification — Windows, 2026-11-13

Environment: Magpie 0.1.3930, Codex CLI 0.167.2, pinned `codex-chatgpt-web` v6.1.18. This records verified behavior and unsuccessful attempts separately.

## Native tools and rendering

Both explicit GPT-5.6 Pro and GPT-6 Pro selectors completed the same two-turn invoice task. The first turn read the implementation and ran three tests, producing one pass and two failures. The second turn changed the implementation using `apply_patch`, then passed all three tests. The test files were unchanged; both had SHA-256 `691f374b72c351cdd9e2a57b53826335b3664d831cab0181fd92b4574d4d91dc`.

Magpie recorded the served Pro model identities and per-request token usage. Approximately 23–25K input tokens per request were observed; larger CLI totals were cumulative across requests and are not context-window measurements.

After installing 0.5.4, a fresh GPT-6 Pro session read the invoice implementation and ran all three tests successfully. Its Markdown tables contained complete single-line rows. The plugin daemon restarted with a new port while retaining the signed-in account and 40-entry catalogue.

That same session then completed a real context compaction. The encrypted checkpoint grew from 626 to 1,227 bytes. After an idle daemon restart changed the listening port, the session resumed, executed real file reads and passed the three tests again. The account-owned tunnel inventory contained exactly one alias, matching the current daemon. This is a small-context restart check, not a full-window compression test.

## Quota card

Live `magpie quota refresh chatgpt-web --json` returned a `subscription` entry with plan `ChatGPT Pro (prolite)` and a text-only unknown allowance window. It no longer returned the generic missing Balance URL placeholder. No verified remaining allowance or reset time was available.

The host's Go response supplies numeric `used: 0` / `remaining: 100` placeholders alongside `text: true`; they are not measurements. A regression executes the installed UI's quota renderers in both Used and Left modes and confirms that the visible card shows Unknown with no percentage meter. A measured-zero control still displays its correct meter. Focused documentation/host tests passed 19/19; four upstream Go normalization/routing tests also passed. Routing excludes the text-only window from measured allowance.

## Large-context attempts and limits

Full-window live validation **did not pass**. Large inline input encountered Chinese ChatGPT service alerts; the prior runtime misreported those as disappearing response DOM. A short read-only control succeeded. The localized alert regression is now covered against the actual patched bundle in isolated Chrome.

An initial app-server additional-context trial truncated each oversized entry to about 4,075 characters. It is excluded from capacity evidence. The corrected trial used 311 entries, each below 3,500 characters; the rollout preserved every fixture fragment. It reached multipart stage 1, encountered a service alert, and did not complete. No successful recall, large-window compaction, or restart continuation is claimed for that trial.

A reduced fixture preserved all 12 markers across 267 small entries. It completed six-part staging and real tool execution; the largest reported per-request input was 276,184 tokens. However, only the last four markers were recovered. A no-tool control (275,389 input tokens) and an all-Pro-staging control produced the identical 4/12 result. This rules out tool execution or the staging effort switch as the sole cause. It does not establish whether the upstream model, account tier or another transport behavior is responsible. The all-Pro experiment was reverted. Automatic compaction completed afterward, but that does not validate the missing information.

Offline calibration used the actual reference compiler and worker preflight at commit `1cc49aaa627a995d3f0cf2f971fde7f764996649`, recovered rollout messages and base instructions, and stopped at a replaced browser boundary:

| Fixture | Compiled input estimate | Largest physical part | Result before browser work |
| --- | ---: | ---: | --- |
| Corrected live-trial rollout | 316,020 | 51,865 | Accepted offline |
| Reduced calibration fixture | 275,903 | 45,042 | Accepted offline |
| Over-limit fixture | 340,069 | 55,543 | Rejected: `context_length_exceeded`, HTTP 400, non-retryable |

The over-limit test reached the browser boundary zero times. Accepted controls reached only an inert sentinel; they never opened a browser. Complete tool schemas and hidden server-side overhead could not be reconstructed and are explicitly unknown. Counts include the reference's estimated 8,192-token platform reserve, which is not a measured upstream cost.

Reference Pro Bigger settings advertise a 336,579 transaction ceiling and 285,000 auto-compaction target. The earlier plugin advertised approximately 316.7K and Codex reported an effective 300,833 window. The final 0.5.4 release withdraws that unverified Pro expansion: the catalogue retains the ordinary 112,193/95,000 reference budgets (about 105.6K published). A runtime guard rejects compiled Pro input at or above 112,193 tokens before browser work. It checks full canonical history on every adapter round, including incoming tool results, and also checks the physical browser preparation; a small resume delta cannot bypass it. It never discards messages to fit. This baseline is not an exhaustive guarantee of all inputs below the boundary.

## Regression and package checks

`node --test --test-concurrency=4`, with the pinned compaction smoke and isolated Chrome terminal-alert tests enabled: **1,304 passed, two skipped, zero failed**. An earlier fully parallel run hit the existing 25 ms regex-protection deadline on a valid schema fixture; the protection was retained. Package dependency, lifecycle, manifest, lockfile and credential checks passed on a clean packed tree. No credential-bearing logs or browser profiles are included in this report.
