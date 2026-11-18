# Historical subagent model tooltip

T3 Code v0.1.10 shows `Not reported` in a completed Claude subagent's tooltip even though the server has its `claude-haiku-4-5-20251001` model.

With Node.js 26, npm, and the T3 Code `t3` command on your `PATH`, run from the repository root:

```sh
node repro/historical-subagent-model/repro.mjs
```

1. Open the local pairing URL printed by the script and connect if prompted.
2. Select **Historical subagent model repro** in the sidebar.
3. Scroll to the top of the conversation and click **Load earlier turns**.
4. Expand **Worked for…** in the first turn, then hover over **Historical child**.

- **Actual** · `Not reported`
- **Expected** · `Haiku 4.5`

The fixture contains one completed Claude subagent and 12 short follow-up turns that put it outside T3's initial history window. The script imports the synthetic history with `@ilyagulya/t3-import@0.5.0-native.11` and runs T3 on loopback with a temporary data directory. It uses no provider credentials or model calls. Press Ctrl+C to stop the server and delete the fixture.
