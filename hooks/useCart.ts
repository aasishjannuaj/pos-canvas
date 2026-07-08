"use client";

import { useState } from "react";

export type CartItem = {
  id: string;
  name: string;
  price: number;
  quantity: number;
};

export function useCart() {
  const [cart, setCart] = useState<CartItem[]>([]);

  // ADD ITEM
  const addToCart = (item: Omit<CartItem, "quantity">) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === item.id);

      if (existing) {
        return prev.map((i) =>
          i.id === item.id
            ? { ...i, quantity: i.quantity + 1 }
            : i
        );
      }

      return [...prev, { ...item, quantity: 1 }];
    });
  };

  // INCREASE
  const increaseQty = (id: string) => {
    setCart((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, quantity: i.quantity + 1 } : i
      )
    );
  };

  // DECREASE
  const decreaseQty = (id: string) => {
    setCart((prev) =>
      prev
        .map((i) =>
          i.id === id
            ? { ...i, quantity: i.quantity - 1 }
            : i
        )
        .filter((i) => i.quantity > 0)
    );
  };

  // REMOVE
  const removeItem = (id: string) => {
    setCart((prev) => prev.filter((i) => i.id !== id));
  };

  // TOTAL
  const total = cart.reduce(
    (sum, i) => sum + i.price * i.quantity,
    0
  );

  // CLEAR
  const clearCart = () => setCart([]);

  return {
    cart,
    addToCart,
    increaseQty,
    decreaseQty,
    removeItem,
    total,
    clearCart,
  };
}