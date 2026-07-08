"use client";

import CartItem from "./CartItem";

export type CartItemData = {
  id: string;
  name: string;
  price: number;
  quantity: number;
};

interface Props {
  items: CartItemData[];
  onIncrease: (id: string) => void;
  onDecrease: (id: string) => void;
  onRemove: (id: string) => void;
}

export default function Cart({
  items,
  onIncrease,
  onDecrease,
  onRemove,
}: Props) {
  return (
    <div>
      <h2>Cart</h2>

      {items.length === 0 ? (
        <p style={{ opacity: 0.6 }}>Cart is empty</p>
      ) : (
        items.map((item) => (
          <CartItem
            key={item.id}
            item={item}
            onIncrease={onIncrease}
            onDecrease={onDecrease}
            onRemove={onRemove}
          />
        ))
      )}
    </div>
  );
}