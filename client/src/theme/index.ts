import { extendTheme } from "@chakra-ui/react";

// Design System 2026 - "Industrial-Eco" Palette
// Brand Persona: "The Honest Inspector" - Reliable, objective, clear
export const colors = {
  // PRIMARY: Thai PBS Orange - Dawn of hope and public connection
  primary: {
    50: "#FFF0EB",
    100: "#FFD1C4",
    200: "#FFAEA2",
    300: "#FF8876",
    400: "#FF614E",
    500: "#F05223", // Main brand - Thai PBS Orange
    600: "#D23F15",
    700: "#B2300D",
    800: "#932207",
    900: "#741703",
  },
  // NEUTRAL: Slate grays for UI
  slate: {
    50: "#f8fafc", // Main BG
    100: "#f1f5f9",
    200: "#e2e8f0", // Borders
    300: "#cbd5e1",
    400: "#94a3b8", // Muted Text
    500: "#64748b", // Secondary Text
    600: "#475569",
    700: "#334155", // Primary Text
    800: "#1e293b", // Headings
    900: "#0f172a", // Dark backgrounds
  },
  // ACCENT COLORS per Design System
  accent: {
    green: "#10B981",   // Eco Green - "Green Industry" ratings, clean records
    orange: "#F05223",  // Thai PBS Orange (updated from safety orange)
    crimson: "#EF4444", // Alert Crimson - High-risk pollution, closed factories ONLY
  },
  // Legacy mappings for backward compatibility
  navy: "#F05223",    // primary.500
  beige: "#f8fafc",   // slate.50
  orange: {
    50: "#FFF0EB",
    100: "#FFD1C4",
    200: "#FFAEA2",
    300: "#FF8876",
    400: "#FF614E",
    500: "#F05223",
    600: "#D23F15",
    700: "#B2300D",
    800: "#932207",
    900: "#741703",
  },
  gray: "#94a3b8",    // slate.400
  sky: "#F05223",     // primary.500 (updated from old blue)
  steel: "#64748b",   // slate.500
};

// Typography: "The Clear Communicator"
// Primary (Thai): IBM Plex Sans Thai - modern, professional, excellent readability
// Secondary (English/Numbers): Inter - perfect for Juristic IDs and technical data
export const fonts = {
  heading: `'IBM Plex Sans Thai', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
  body: `'IBM Plex Sans Thai', 'Noto Sans Thai', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
};

// Properly configured Chakra UI theme
export const theme = extendTheme({
  colors: {
    brand: colors,
    ...colors, // Spread for direct access
  },
  fonts,
  shadows: {
    sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
    md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
    lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
    xl: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
    "2xl": "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    outline: "0 0 0 3px rgba(59, 130, 246, 0.5)",
  },
  components: {
    Button: {
      baseStyle: {
        fontWeight: "600",
        borderRadius: "lg",
      },
      variants: {
        solid: {
          bg: "primary.600",
          color: "white",
          _hover: {
            bg: "primary.700",
            transform: "translateY(-1px)",
            boxShadow: "md",
          },
          _active: {
            bg: "primary.800",
            transform: "translateY(0)",
          },
        },
        ghost: {
          color: "slate.600",
          _hover: {
            bg: "slate.100",
            color: "slate.900",
          },
        },
        outline: {
          borderColor: "slate.200",
          color: "slate.700",
          _hover: {
            bg: "slate.50",
            borderColor: "slate.300",
          },
        },
      },
      defaultProps: {
        colorScheme: "primary",
      },
    },
    Input: {
      variants: {
        filled: {
          field: {
            bg: "slate.50",
            _hover: {
              bg: "slate.100",
            },
            _focus: {
              bg: "white",
              borderColor: "primary.500",
            },
          },
        },
        outline: {
          field: {
            borderColor: "slate.200",
            borderRadius: "lg",
            _hover: {
              borderColor: "slate.300",
            },
            _focus: {
              borderColor: "primary.500",
              boxShadow: "0 0 0 1px #3b82f6",
            },
          },
        },
      },
      defaultProps: {
        variant: "outline",
      },
    },
    Badge: {
      baseStyle: {
        borderRadius: "full",
        textTransform: "none",
        fontWeight: "medium",
        px: 2,
        py: 0.5,
      },
    },
    Card: {
      baseStyle: {
        container: {
          borderRadius: "xl",
          bg: "white",
          boxShadow: "sm",
          border: "1px solid",
          borderColor: "slate.100",
        },
      },
    },
  },
  styles: {
    global: {
      body: {
        bg: "slate.50",
        color: "slate.800",
      },
      "::-webkit-scrollbar": {
        width: "8px",
        height: "8px",
      },
      "::-webkit-scrollbar-track": {
        bg: "transparent",
      },
      "::-webkit-scrollbar-thumb": {
        bg: "slate.300",
        borderRadius: "full",
        _hover: {
          bg: "slate.400",
        },
      },
    },
  },
});

export default theme;
