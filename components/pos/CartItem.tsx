"use client";

export type CartItemData = {
  id: string;
  name: string;
  price: number;
  quantity: number;
};

interface Props {
  item: CartItemData;
  onIncrease: (id: string) => void;
  onDecrease: (id: string) => void;
  onRemove: (id: string) => void;
}

export default function CartItem({
  item,
  onIncrease,
  onDecrease,
  onRemove,
}: Props) {
  return (
    <div style={{ marginBottom: "12px", border: "1px solid #ddd", padding: "10px" }}>
      <div><b>{item.name}</b></div>

      <div>
        {item.quantity} × ${item.price}
      </div>

      <div style={{ display: "flex", gap: "5px", marginTop: "5px" }}>
        <button onClick={() => onDecrease(item.id)}>-</button>
        <button onClick={() => onIncrease(item.id)}>+</button>
        <button onClick={() => onRemove(item.id)}>x</button>
      </div>
    </div>
  );
}