const wallImg = document.getElementById("wall");
const empty = document.getElementById("empty");
const status = document.getElementById("status");
const meta = document.getElementById("meta");

function showWall(w) {
  empty.style.display = "none";
  wallImg.style.display = "block";
  wallImg.style.opacity = 0;
  const url = `${w.image_url}?t=${Date.now()}`;
  const pre = new Image();
  pre.onload = () => {
    wallImg.src = url;
    wallImg.style.opacity = 1;
  };
  pre.src = url;
  meta.textContent = `${w.title || ""}  ${w.date || ""}`;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/display`);
  ws.onopen = () => (status.textContent = "已联通手机端");
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "wall") showWall(msg);
  };
  ws.onclose = () => {
    status.textContent = "断开，重连中…";
    setTimeout(connect, 2000);
  };
}
connect();
