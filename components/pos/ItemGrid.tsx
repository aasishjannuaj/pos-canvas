"use client";

export interface PosItem {
  id: string;
  name: string;
  price: number;
}

interface Props {
  items?: PosItem[];
  onAdd?: (item: PosItem) => void;
}

const placeholderItems: PosItem[] = [
  { id: "1", name: "Burger", price: 5 },
  { id: "2", name: "Coffee", price: 3 },
  { id: "3", name: "Sandwich", price: 6 },
  { id: "4", name: "Fries", price: 4 },
];

export default function ItemGrid({
  items = placeholderItems,
  onAdd,
}: Props) {
  return (
    <div>
      <h2>Items</h2>

      <div style={{ display: "grid", gap: "10px" }}>
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onAdd?.(item)}
            style={{
              padding: "10px",
              border: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            {item.name} - ${item.price}
          </button>
        ))}
      </div>
    </div>
  );
}