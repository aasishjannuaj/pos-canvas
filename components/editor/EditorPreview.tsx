const menuSections = [
  {
    name: "Breakfast",
    items: [
      { name: "Bacon Egg & Cheese", price: "$6.49" },
      { name: "Egg & Cheese", price: "$4.99" },
      { name: "Hash Browns", price: "$2.49" },
      { name: "Coffee", price: "$2.25" },
    ],
  },
  {
    name: "Lunch",
    items: [
      { name: "Turkey Grinder", price: "$8.95" },
      { name: "Roast Beef", price: "$9.25" },
      { name: "Chicken Grinder", price: "$8.75" },
    ],
  },
  {
    name: "Drinks",
    items: [
      { name: "Coke", price: "$1.99" },
      { name: "Sprite", price: "$1.99" },
      { name: "Water", price: "$1.49" },
    ],
  },
];

export default function EditorPreview() {
  return (
    <div className="flex flex-1 items-center justify-center overflow-auto bg-neutral-100 p-10">
      <div className="flex aspect-[9/16] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* POS Header */}
        <div className="flex-none border-b border-neutral-200 bg-neutral-900 px-4 py-3">
          <span className="text-sm font-semibold tracking-tight text-white">
            Restaurant POS
          </span>
        </div>

        {/* Section Tabs */}
        <div className="flex flex-none gap-2 border-b border-neutral-200 bg-white px-3 py-2">
          {menuSections.map((section, index) => (
            <span
              key={section.name}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                index === 0
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600"
              }`}
            >
              {section.name}
            </span>
          ))}
        </div>

        {/* Menu Content */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-4">
            {menuSections.map((section) => (
              <div key={section.name} className="flex flex-col gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {section.name}
                </span>

                <div className="grid grid-cols-2 gap-2">
                  {section.items.map((item) => (
                    <div
                      key={item.name}
                      className="flex flex-col justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5"
                    >
                      <span className="text-xs font-medium leading-tight text-neutral-900">
                        {item.name}
                      </span>
                      <span className="text-xs font-semibold text-blue-600">
                        {item.price}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
