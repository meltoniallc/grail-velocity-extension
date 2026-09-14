async function load() {
  const data = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
  document.getElementById("tapeApi").value = data.tapeApi || "http://127.0.0.1:8787";
  document.getElementById("tapeSecret").value = data.tapeSecret || "";
}

document.getElementById("opts").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tapeApi = document.getElementById("tapeApi").value.trim().replace(/\/+$/, "");
  const tapeSecret = document.getElementById("tapeSecret").value.trim();
  await chrome.storage.local.set({ tapeApi, tapeSecret });
  document.getElementById("status").textContent = "Saved. Reload eBay tabs to pick up the endpoint.";
});

load();
