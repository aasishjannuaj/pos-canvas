"use client";

interface Props {
  total: number;
  onCheckout: () => void;
}

export default function CheckoutBar({ total, onCheckout }: Props) {
  return (
    <div style={{ marginTop: "20px", padding: "10px", borderTop: "1px solid #ddd" }}>
      
      <h3>Total: ${total.toFixed(2)}</h3>

      <button
        onClick={onCheckout}
        style={{
          padding: "10px",
          background: "black",
          color: "white",
          border: "none",
          cursor: "pointer",
          marginTop: "10px",
        }}
      >
        Checkout
      </button>

    </div>
  );
}