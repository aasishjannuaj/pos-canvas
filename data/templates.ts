export interface Template {
    id: string;
    name: string;
    description: string;
    icon: string;
    route: string;
  }
  
  export const templates: Template[] = [
    {
      id: "restaurant",
      name: "Restaurant",
      description: "Perfect for restaurants, delis and cafés.",
      icon: "🍔",
      route: "/pos",
    },
    {
      id: "cafe",
      name: "Cafe",
      description: "Coffee shops and cafés.",
      icon: "☕",
      route: "#",
    },
    {
      id: "retail",
      name: "Retail",
      description: "Retail stores and convenience shops.",
      icon: "🛍",
      route: "#",
    },
  ];