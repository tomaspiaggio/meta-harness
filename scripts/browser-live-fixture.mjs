import { createServer } from "node:http";

export async function browserFixture() {
  let observation = { user: "", password: "", clicks: 0, events: 0 };
  const fixture = createServer(async (request, response) => {
    if (request.url === "/observations") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(observation));
      return;
    }
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/")
      observation = { user: "", password: "", clicks: 0, events: 0 };
    if (request.url === "/observe" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      observation = {
        ...observation,
        ...JSON.parse(body),
        events: observation.events + 1,
      };
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body style="margin:0;background:#eff6ff;font:24px sans-serif"><h1 style="padding:20px">Managed browser test</h1><p id="clock"></p>
  <input id="user" aria-label="Username" style="position:absolute;left:400px;top:260px;width:400px;height:40px;font-size:24px">
  <input id="password" type="password" aria-label="Password" style="position:absolute;left:400px;top:350px;width:400px;height:40px;font-size:24px">
  <button id="login" style="position:absolute;left:400px;top:440px;width:400px;height:50px" onclick="localStorage.setItem('fixture-login','yes');document.cookie='fixture-login=yes; SameSite=Lax';fetch('/observe',{method:'POST',body:JSON.stringify({clicks:1})});this.textContent='Signed in'">Sign in</button>
  <script>setInterval(()=>{document.getElementById('clock').textContent='Live animation '+Date.now()},80);for(const id of ['user','password']) document.getElementById(id).oninput=e=>fetch('/observe',{method:'POST',body:JSON.stringify({[id]:e.target.value})});</script></body></html>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));

  return {
    server: fixture,
    get observation() {
      return observation;
    },
  };
}

if (process.argv.includes("--serve")) {
  const fixture = await browserFixture();
  console.log(fixture.server.address().port);
}
