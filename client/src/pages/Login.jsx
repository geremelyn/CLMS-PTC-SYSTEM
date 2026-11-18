import { useState } from 'react';
import api from '../api';
import { useNavigate } from 'react-router-dom';
import { getDefaultDashboard } from '../utils/dashboardRoutes.js';
import './Login.css';

function Login() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);

    const navigate = useNavigate();

    async function handleSubmit(event) {
        event.preventDefault();

        setMessage('');
        setLoading(true);

        try {
            const response = await api.post(
                '/auth/login',
                {
                    username,
                    password
                }
            );

            localStorage.setItem(
                'user',
                JSON.stringify({ ...response.data.user, token: response.data.token })
            );

            setMessage(response.data.message);

            // Role -> default dashboard comes from one shared resolver (Others/custom roles only get Change Password).
            navigate(getDefaultDashboard(response.data.user.role, response.data.user.role_other));

        } catch (error) {
            console.error(error);

            if (error.response) {
                setMessage(
                    error.response.data?.message ||
                    'Invalid ID number or password.'
                );
            } else {
                setMessage(
                    'Unable to connect to the server. Please make sure the backend is running.'
                );
            }
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="login-page">

            <div className="background-overlay"></div>

            <div className="login-layout">

                {/* LEFT SIDE */}

                <section className="login-introduction">

                    <p>
                        Pateros Technological College
                    </p>

                    <h1>
                        Computer Laboratory
                        <br />
                        Monitoring System
                        <span className="clms-text"> (CLMS)</span>
                    </h1>


            



                </section>


                {/* RIGHT SIDE - LOGIN */}

                <section className="login-card">

                    <div className="login-logo-container">

                        <img
                            src="/clms-logo.png"
                            alt="CLMS Logo"
                            className="login-logo"
                        />

                    </div>


                    <div className="login-header">

                        <h2>
                            Welcome Back
                        </h2>

                        <p>
                            Sign in to continue
                        </p>

                    </div>


                    <form onSubmit={handleSubmit}>

                        {/* USERNAME */}

                        <div className="form-group">

                            <label htmlFor="username">
                                ID Number
                            </label>

                            <div className="input-container">

                                <span className="input-icon">
                                    
                                </span>

                                <input
                                    type="text"
                                    id="username"
                                    name="username"
                                    placeholder="Enter your ID number"
                                    value={username}
                                    onChange={(event) =>
                                        setUsername(event.target.value)
                                    }
                                    autoComplete="username"
                                    required
                                />

                            </div>

                        </div>


                        {/* PASSWORD */}

                        <div className="form-group">

                            <label htmlFor="password">
                                Password
                            </label>

                            <div className="input-container">

                                <span className="input-icon">
                                    
                                </span>

                                <input
                                    type={
                                        showPassword
                                            ? 'text'
                                            : 'password'
                                    }
                                    id="password"
                                    name="password"
                                    placeholder="Enter your password"
                                    value={password}
                                    onChange={(event) =>
                                        setPassword(event.target.value)
                                    }
                                    autoComplete="current-password"
                                    required
                                />

                                <button
                                    type="button"
                                    className="show-password"
                                    onClick={() =>
                                        setShowPassword(!showPassword)
                                    }
                                    aria-label={
                                        showPassword
                                            ? 'Hide password'
                                            : 'Show password'
                                    }
                                >
                                    {showPassword ? (
                                        <svg
                                            viewBox="0 0 24 24"
                                            aria-hidden="true"
                                        >
                                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                                            <circle cx="12" cy="12" r="3" />
                                        </svg>
                                    ) : (
                                        <svg
                                            viewBox="0 0 24 24"
                                            aria-hidden="true"
                                        >
                                            <path d="m3 3 18 18" />
                                            <path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.8 18.8 0 0 1-3.1 3.8" />
                                            <path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 3.4-.6" />
                                            <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                                        </svg>
                                    )}
                                </button>

                            </div>

                        </div>


                        {/* OPTIONS */}

                        <div className="login-options">

                            <label className="remember-me">

                                <input
                                    type="checkbox"
                                />

                                <span>
                                    Remember me
                                </span>

                            </label>


                            <button
                                type="button"
                                className="forgot-password"
                                onClick={() =>
                                    setMessage(
                                        'Please contact the system administrator to reset your password.'
                                    )
                                }
                            >
                                Forgot password?
                            </button>

                        </div>


                        {/* MESSAGE */}

                        {message && (
                            <div className="login-message">
                                {message}
                            </div>
                        )}


                        {/* LOGIN BUTTON */}

                        <button
                            type="submit"
                            className="signin-button"
                            disabled={loading}
                        >
                            {loading ? (
                                <>
                                    <span className="spinner"></span>
                                    Signing in...
                                </>
                            ) : (
                                'Sign In'
                            )}
                        </button>

                    </form>


                    <div className="login-footer">

                        <p>
                            Secure access for authorized users
                        </p>

                    </div>

                </section>

            </div>


            <div className="copyright">
                © 2026 Pateros Technological College · Computer Laboratory Monitoring System (CLMS)
            </div>

        </main>
    );
}

export default Login;