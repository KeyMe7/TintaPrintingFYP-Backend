import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Root route
app.get("/", (req, res) => {
  res.send("TintaPrintingFYP Backend is running 🚀");
});

// ToyyibPay return URL
app.get("/payment/return", (req, res) => {
  const { status_id, billcode } = req.query;
  console.log(`Return from ToyyibPay: ${billcode}, status: ${status_id}`);
  res.send(`Payment return received! Status: ${status_id}`);
});

// ToyyibPay callback URL
app.post("/payment/callback", (req, res) => {
  console.log("Callback from ToyyibPay:", req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
