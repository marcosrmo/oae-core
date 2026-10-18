const base = "http://127.0.0.1:4097";
process.env.OAE_OPENCODE_URL = base;
const { connect } = await import("/home/dev/projetos/oae-inspecao/dist/opencode.js");
const { client } = await connect();
const s = await client.session.create({ body: { title: "rea-spawn-probe2" } });
console.log("session", s.data?.id ?? s.id);
await new Promise(r => setTimeout(r, 15000));
process.exit(0);
