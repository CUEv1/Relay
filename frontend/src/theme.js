import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#0f1535',
      paper: 'rgba(255,255,255,0.05)',
    },
    primary: {
      main: '#4facfe',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#7367f0',
    },
    error: {
      main: '#fc5151',
    },
    warning: {
      main: '#f5a524',
    },
    success: {
      main: '#00e676',
    },
    text: {
      primary: '#ffffff',
      secondary: '#a0aec0',
    },
  },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { fontSize: '1.38rem', fontWeight: 800, lineHeight: 1.2 },
    h2: { fontSize: '0.95rem', fontWeight: 700 },
    button: { textTransform: 'none', fontWeight: 700 },
  },
  shape: {
    borderRadius: 16,
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 16,
          backgroundImage: 'none',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontSize: 13,
          whiteSpace: 'nowrap',
        },
        contained: {
          background: 'linear-gradient(90deg, #4facfe 0%, #7367f0 100%)',
          color: '#ffffff',
          '&:hover': {
            background: 'linear-gradient(90deg, #3d9fe8 0%, #6055d8 100%)',
          },
        },
        outlined: {
          borderColor: 'rgba(79,172,254,0.4)',
          color: '#4facfe',
          '&:hover': {
            borderColor: 'rgba(79,172,254,0.8)',
            background: 'rgba(79,172,254,0.08)',
          },
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            background: 'rgba(255,255,255,0.06)',
            borderRadius: 10,
            '& fieldset': {
              borderColor: 'rgba(255,255,255,0.12)',
            },
            '&:hover fieldset': {
              borderColor: 'rgba(79,172,254,0.35)',
            },
            '&.Mui-focused fieldset': {
              borderColor: 'rgba(79,172,254,0.65)',
            },
          },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': {
            color: '#ffffff',
            '& + .MuiSwitch-track': {
              background: 'linear-gradient(90deg, #4facfe 0%, #7367f0 100%)',
              opacity: 1,
            },
          },
        },
        track: {
          backgroundColor: 'rgba(255,255,255,0.18)',
        },
      },
    },
  },
});
