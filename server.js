import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// Root route
app.get("/", (req, res) => {
  res.send("TintaPrintingFYP Backend is running 🚀");
});

// Serve the polished payment page (static file)
// ToyyibPay will redirect: /payment/return?status_id=1&billcode=abc123
app.get("/payment/return", (req, res) => {
  // We just send the static HTML — it will read query params itself
  res.sendFile(path.join(__dirname, "public", "payment_return.html"));
});

// ToyyibPay callback (server-to-server)
app.post("/payment/callback", (req, res) => {
  console.log("Callback from ToyyibPay:", req.body);
  // TODO: here you can parse req.body and update Firebase using Admin SDK
  res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
