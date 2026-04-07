import { extendTheme } from "@chakra-ui/react";

// Design System 2026 - "Industrial-Eco" Palette
// Brand Persona: "The Honest Inspector" - Reliable, objective, clear
export const colors = {
  // PRIMARY: Industrial Blue - Deep, professional for headers and trust
  primary: {
    50: "#e8eef5",
    100: "#c5d4e6",
    200: "#9fb8d5",
    300: "#7a9cc4",
    400: "#5d86b7",
    500: "#1A365D", // Main Brand - Industrial Blue
    600: "#162d4e",
    700: "#12243f",
    800: "#0e1b30",
    900: "#0a1221",
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
    orange: "#F59E0B",  // Safety Orange - Action items, Search buttons, Warning icons
    crimson: "#EF4444", // Alert Crimson - High-risk pollution, closed factories ONLY
  },
  // Legacy mappings for backward compatibility
  navy: "#1A365D",    // primary.500
  beige: "#f8fafc",   // slate.50
  orange: "#F59E0B",  // accent.orange
  gray: "#94a3b8",    // slate.400
  sky: "#1A365D",     // primary.500 (updated from old blue)
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
