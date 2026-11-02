const express = require("express");
const cors = require("cors");
const path = require("path");
const api = require("./api");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// API routes
app.use("/api", api);

// In production, serve the built renderer
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "dist", "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`EmbedFactory local server running on http://localhost:${PORT}`);
});
