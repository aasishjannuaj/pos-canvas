"use client";

import ItemGrid from "@/components/pos/ItemGrid";
import Cart from "@/components/pos/Cart";
import CheckoutBar from "@/components/pos/CheckoutBar";
import { useCart } from "@/hooks/useCart";

export default function POSPage() {
  const {
    cart,
    addToCart,
    increaseQty,
    decreaseQty,
    removeItem,
    total,
    clearCart,
  } = useCart();

  const checkout = () => {
    if (cart.length === 0) {
      alert("Cart is empty");
      return;
    }

    alert(
      "Order Completed!\n\n" +
        cart.map((i) => `${i.name} x${i.quantity}`).join("\n") +
        `\n\nTotal: $${total.toFixed(2)}`
    );

    clearCart();
  };

  return (
    <div style={{ display: "flex", gap: "20px", padding: "20px" }}>
      
      <div style={{ flex: 2 }}>
        <ItemGrid onAdd={addToCart} />
      </div>

      <div style={{ flex: 1 }}>
        <Cart
          items={cart}
          onIncrease={increaseQty}
          onDecrease={decreaseQty}
          onRemove={removeItem}
        />
        <CheckoutBar total={total} onCheckout={checkout} />
      </div>

    </div>
  );
}