/**
 * ============================================================
 * LoginPage - Full Page Login/Register with Informative Left Panel
 * Includes inline Forgot Password flow
 * ============================================================
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useBranding } from "@/components/BrandingProvider";
import { apiRequest } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import { AILoadingAnimation } from "@/components/landing/AILoadingAnimation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  ArrowLeft, Eye, EyeOff, Check,
  Bot, Layers, Brain, Zap, Mail, KeyRound, Play
} from "lucide-react";
import { Link } from "wouter";
import { useDemoMode } from "@/components/DemoModeBanner";

type ViewType = "login" | "register" | "register-otp" | "forgot-password" | "reset-password";

export default function LoginPage() {
  const { t } = useTranslation();
  const { isDemoMode } = useDemoMode();
  const [location, setLocation] = useLocation();
  const initialTab = location === "/register" ? "register" : "login";
  const [activeView, setActiveView] = useState<ViewType>(initialTab);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showLoadingAnimation, setShowLoadingAnimation] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState<string>("");
  const [otpTimer, setOtpTimer] = useState(0);
  const [registerOtpCode, setRegisterOtpCode] = useState<string>("");
  const [canResendOtp, setCanResendOtp] = useState(false);
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const { toast } = useToast();
  const { branding, currentLogo } = useBranding();

  const loginSchema = z.object({
    email: z.string().email(t("loginPage.errors.invalidEmail")),
    password: z.string().min(1, t("loginPage.errors.passwordRequired")),
  });

  const registerSchema = z.object({
    name: z.string().min(2, t("loginPage.errors.nameLength")),
    email: z.string().email(t("loginPage.errors.invalidEmail")),
    password: z.string().min(8, t("loginPage.errors.passwordLength")),
    confirmPassword: z.string(),
  }).refine((data) => data.password === data.confirmPassword, {
    message: t("loginPage.errors.passwordsMatch"),
    path: ["confirmPassword"],
  });

  const forgotPasswordSchema = z.object({
    email: z.string().email(t("loginPage.errors.invalidEmail")),
  });

  const resetPasswordSchema = z.object({
    otp: z.string().min(6, t("loginPage.errors.otpLength")),
    newPassword: z.string().min(8, t("loginPage.errors.passwordLength")),
    confirmPassword: z.string(),
  }).refine((data) => data.newPassword === data.confirmPassword, {
    message: t("loginPage.errors.passwordsMatch"),
    path: ["confirmPassword"],
  });

  type LoginFormData = z.infer<typeof loginSchema>;
  type RegisterFormData = z.infer<typeof registerSchema>;
  type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;
  type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

  const features = [
    {
      icon: Bot,
      title: t("loginPage.leftPanel.features.templates.title"),
      description: t("loginPage.leftPanel.features.templates.description")
    },
    {
      icon: Layers,
      title: t("loginPage.leftPanel.features.custom.title"),
      description: t("loginPage.leftPanel.features.custom.description")
    },
    {
      icon: Brain,
      title: t("loginPage.leftPanel.features.context.title"),
      description: t("loginPage.leftPanel.features.context.description")
    },
    {
      icon: Zap,
      title: t("loginPage.leftPanel.features.updates.title"),
      description: t("loginPage.leftPanel.features.updates.description")
    }
  ];

  const stats = [
    { value: "100+", label: t("loginPage.leftPanel.stats.countries") },
    { value: "30+", label: t("loginPage.leftPanel.stats.languages") },
    { value: "99.9%", label: t("loginPage.leftPanel.stats.uptime") },
    { value: "24/7", label: t("loginPage.leftPanel.stats.support") }
  ];

  // OTP timer countdown
  useEffect(() => {
    if (otpTimer > 0) {
      const timer = setTimeout(() => setOtpTimer(otpTimer - 1), 1000);
      return () => clearTimeout(timer);
    } else if (otpTimer === 0 && (activeView === 'register-otp' || activeView === 'reset-password')) {
      setCanResendOtp(true);
    }
  }, [otpTimer, activeView]);

  const loginForm = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  useEffect(() => {
    if (isDemoMode) {
      loginForm.reset({ email: "demo@diploy.in", password: "Demo@1234" });
    }
  }, [isDemoMode, loginForm]);

  const registerForm = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  const forgotPasswordForm = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const resetPasswordForm = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { otp: "", newPassword: "", confirmPassword: "" },
  });

  const handleLoadingComplete = () => {
    // Navigate using SPA routing - don't hide the loader first
    // The component will unmount naturally when navigation completes
    if (pendingRedirect) {
      setLocation(pendingRedirect);
    }
  };

  const handleLogin = async (data: LoginFormData) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Login failed");
      }

      AuthStorage.setAuthData(result.token, result.user, result.refreshToken, result.expiresIn);
      setUserName(result.user.name || result.user.email.split('@')[0]);

      toast({ title: t("loginPage.toasts.welcomeBack"), description: t("loginPage.toasts.loginSuccess") });

      // Show loading animation then redirect based on user role
      const redirectPath = (result.user.role === 'admin' || result.user.role === 'super_admin') ? "/admin" : "/app";
      setPendingRedirect(redirectPath);
      setShowLoadingAnimation(true);
    } catch (error: any) {
      toast({ title: t("loginPage.errors.loginFailed"), description: error.message || t("loginPage.errors.invalidCredentials"), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  // Step 1: Send OTP for registration
  const handleSendRegistrationOTP = async (data: RegisterFormData) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.email,
          name: data.name,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || t("loginPage.errors.sendOtpFailed"));
      }

      toast({
        title: t("loginPage.toasts.codeSent"),
        description: t("loginPage.toasts.checkEmailAt", { email: data.email }),
      });

      setActiveView('register-otp');
      setOtpTimer(300); // 5 minutes countdown
      setCanResendOtp(false);
      setRegisterOtpCode("");
    } catch (error: any) {
      toast({
        title: t("loginPage.errors.sendOtpFailed"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Resend OTP for registration
  const handleResendRegistrationOTP = async () => {
    const data = registerForm.getValues();
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.email,
          name: data.name,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || t("loginPage.errors.sendOtpFailed"));
      }

      toast({
        title: t("loginPage.toasts.codeSent"),
        description: t("loginPage.toasts.otpSent"),
      });

      setOtpTimer(300);
      setCanResendOtp(false);
      setRegisterOtpCode("");
    } catch (error: any) {
      toast({
        title: t("loginPage.errors.sendOtpFailed"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Step 2: Verify OTP and complete registration
  const handleVerifyAndRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (registerOtpCode.length !== 6) {
      toast({ title: t("loginPage.errors.invalidCode"), description: t("loginPage.errors.otpLength"), variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      // First verify the OTP
      const verifyResponse = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: registerForm.getValues().email,
          otpCode: registerOtpCode,
        }),
      });

      const verifyResult = await verifyResponse.json();

      if (!verifyResponse.ok) {
        throw new Error(verifyResult.error || t("loginPage.errors.invalidCode"));
      }

      // OTP verified successfully, now complete registration
      const registerData = registerForm.getValues();
      const registerResponse = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: registerData.email,
          password: registerData.password,
          name: registerData.name,
        }),
      });

      const result = await registerResponse.json();

      if (!registerResponse.ok) {
        throw new Error(result.error || t("loginPage.errors.genericError"));
      }

      AuthStorage.setAuthData(result.token, result.user, result.refreshToken, result.expiresIn);
      setUserName(result.user.name || result.user.email.split('@')[0]);

      toast({
        title: t("loginPage.toasts.registrationSuccess"),
        description: t("loginPage.toasts.welcomeUser", { name: result.user.name }),
      });

      // Show loading animation then redirect based on user role
      const redirectPath = result.user.role === 'admin' ? "/admin" : "/app";
      setPendingRedirect(redirectPath);
      setShowLoadingAnimation(true);
    } catch (error: any) {
      toast({
        title: t("loginPage.errors.genericError"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToRegisterDetails = () => {
    setActiveView('register');
    setRegisterOtpCode("");
    setOtpTimer(0);
    setCanResendOtp(false);
  };

  const handleForgotPasswordSubmit = async (data: ForgotPasswordFormData) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/forgot-password/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email }),
      });
      const result = await response.json();

      if (response.ok) {
        setForgotPasswordEmail(data.email);
        setOtpTimer(300);
        setCanResendOtp(false);
        setActiveView("reset-password");
        toast({ title: t("loginPage.toasts.codeSent"), description: t("loginPage.rightPanel.form.checkEmail") });
      } else {
        toast({ title: t("loginPage.errors.sendOtpFailed"), description: result.error || t("loginPage.errors.genericError"), variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: t("loginPage.errors.sendOtpFailed"), description: error.message || t("loginPage.errors.genericError"), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendForgotPasswordOTP = async () => {
    if (otpTimer > 0) return;
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/forgot-password/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotPasswordEmail }),
      });
      const result = await response.json();

      if (response.ok) {
        setOtpTimer(300);
        setCanResendOtp(false);
        toast({ title: t("loginPage.toasts.codeSent"), description: t("loginPage.rightPanel.form.checkEmail") });
      } else {
        toast({ title: t("loginPage.errors.genericError"), description: result.error || t("loginPage.errors.genericError"), variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: t("loginPage.errors.genericError"), description: error.message || t("loginPage.errors.genericError"), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (data: ResetPasswordFormData) => {
    setIsLoading(true);
    try {
      // First verify OTP
      const verifyResponse = await fetch("/api/auth/forgot-password/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotPasswordEmail, otpCode: data.otp }),
      });
      const verifyResult = await verifyResponse.json();

      if (!verifyResponse.ok) {
        toast({ title: t("loginPage.errors.invalidCode"), description: verifyResult.error || t("loginPage.errors.checkCode"), variant: "destructive" });
        setIsLoading(false);
        return;
      }

      // Then reset password
      const resetResponse = await fetch("/api/auth/forgot-password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: forgotPasswordEmail,
          newPassword: data.newPassword
        }),
      });
      const resetResult = await resetResponse.json();

      if (resetResponse.ok) {
        toast({ title: t("loginPage.toasts.passwordReset"), description: t("loginPage.toasts.loginWithNew") });
        resetPasswordForm.reset();
        forgotPasswordForm.reset();
        setActiveView("login");
      } else {
        toast({ title: t("loginPage.errors.resetPasswordFailed"), description: resetResult.error || t("loginPage.errors.genericError"), variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: t("loginPage.errors.resetPasswordFailed"), description: error.message || t("loginPage.errors.genericError"), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const getCardTitle = () => {
    switch (activeView) {
      case "login": return t("loginPage.rightPanel.titles.welcome");
      case "register": return t("loginPage.rightPanel.titles.create");
      case "register-otp": return t("loginPage.rightPanel.titles.verify");
      case "forgot-password": return t("loginPage.rightPanel.titles.forgot");
      case "reset-password": return t("loginPage.rightPanel.titles.reset");
    }
  };

  const getCardDescription = () => {
    switch (activeView) {
      case "login": return t("loginPage.rightPanel.descriptions.welcome");
      case "register": return t("loginPage.rightPanel.descriptions.create");
      case "register-otp": return t("loginPage.rightPanel.descriptions.verify", { email: registerForm.getValues().email });
      case "forgot-password": return t("loginPage.rightPanel.descriptions.forgot");
      case "reset-password": return t("loginPage.rightPanel.descriptions.reset", { email: forgotPasswordEmail });
    }
  };

  return (
    <>
      <AILoadingAnimation
        isVisible={showLoadingAnimation}
        onComplete={handleLoadingComplete}
        userName={userName}
      />

      <div className="min-h-screen flex" data-testid="login-page">
        {/* Left side - Informative Panel */}
        <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-[#050B1A] via-[#0a1628] to-[#050B1A] relative overflow-hidden">
          {/* Animated background elements */}
          <div className="absolute inset-0">
            <div className="absolute top-20 left-10 w-72 h-72 bg-brand/10 rounded-full blur-3xl" />
            <div className="absolute bottom-20 right-10 w-96 h-96 bg-brand/5 rounded-full blur-3xl" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-brand/5 rounded-full blur-3xl" />
          </div>

          <div className="relative z-10 flex flex-col justify-between p-12 w-full">
            {/* Logo - Use white logo (logo_url_dark) for dark background */}
            <Link href="/">
              <div className="flex items-center gap-3 cursor-pointer" data-testid="link-logo">
                {branding.logo_url_dark && (
                  <img src={branding.logo_url_dark} alt={branding.app_name} className="h-10" />
                )}
              </div>
            </Link>

            {/* Main Content */}
            <div className="space-y-10">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
              >
                <h1 className="text-4xl xl:text-5xl font-bold leading-tight text-white mb-4">
                  {t("loginPage.leftPanel.title")}
                </h1>
              </motion.div>

              {/* Features List */}
              <motion.div
                className="space-y-6"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.2 }}
              >
                {features.map((feature, index) => (
                  <motion.div
                    key={index}
                    className="flex items-start gap-4"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.4, delay: 0.3 + index * 0.1 }}
                    data-testid={`feature-item-${index}`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-brand/20 border border-brand/30 flex items-center justify-center shrink-0">
                      <feature.icon className="w-5 h-5 text-brand" />
                    </div>
                    <div>
                      <p className="text-white">
                        {t("loginPage.leftPanel.features.accessPreBuilt")} <span className="font-semibold">{feature.title}</span>.{" "}
                        <span className="text-gray-400">{feature.description}</span>
                      </p>
                    </div>
                  </motion.div>
                ))}
              </motion.div>

              {/* Stats Row */}
              <motion.div
                className="pt-8 border-t border-white/10"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.6 }}
              >
                <div className="grid grid-cols-4 gap-6">
                  {stats.map((stat, index) => (
                    <div key={index} className="text-center" data-testid={`stat-${index}`}>
                      <div className="text-2xl font-bold text-brand">{stat.value}</div>
                      <div className="text-sm text-gray-400">{stat.label}</div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>

            {/* Footer */}
            <p className="text-sm text-gray-500">
              &copy; {new Date().getFullYear()} {branding.app_name}. {t("loginPage.leftPanel.copyright")}
            </p>
          </div>
        </div>

        {/* Right side - Login Form */}
        <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-gray-50 dark:bg-[#0a1628]">
          <div className="w-full max-w-md space-y-6">
            {/* Mobile back button */}
            <div className="lg:hidden">
              <Link href="/">
                <Button variant="ghost" size="sm" className="mb-4" data-testid="button-back-home">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  {t("loginPage.rightPanel.backToHome")}
                </Button>
              </Link>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              key={activeView}
            >
              <Card className="border border-gray-200 dark:border-brand/20 shadow-2xl shadow-gray-200/50 dark:shadow-brand/10 bg-white dark:bg-[#0f1d32]">
                <CardHeader className="text-center pb-2">
                  {/* Mobile logo */}
                  <div className="lg:hidden flex justify-center mb-4">
                    {currentLogo && (
                      <img src={currentLogo} alt={branding.app_name} className="h-10" />
                    )}
                  </div>

                  {/* Icon for forgot/reset password views */}
                  {(activeView === "forgot-password" || activeView === "reset-password") && (
                    <div className="flex justify-center mb-4">
                      <div className="w-16 h-16 rounded-full bg-brand/10 border border-brand/30 flex items-center justify-center">
                        {activeView === "forgot-password" ? (
                          <Mail className="w-8 h-8 text-brand" />
                        ) : (
                          <KeyRound className="w-8 h-8 text-brand" />
                        )}
                      </div>
                    </div>
                  )}

                  <CardTitle className="text-2xl font-bold text-gray-900 dark:text-white">
                    {getCardTitle()}
                  </CardTitle>
                  <CardDescription className="text-gray-600 dark:text-gray-400">
                    {getCardDescription()}
                  </CardDescription>
                </CardHeader>

                <CardContent className="pt-4">
                  {/* Login/Register Tabs */}
                  {(activeView === "login" || activeView === "register") && (
                    <Tabs value={activeView} onValueChange={(v) => setActiveView(v as ViewType)}>
                      <TabsList className="grid w-full grid-cols-2 mb-6 bg-gray-100 dark:bg-[#0a1628]">
                        <TabsTrigger
                          value="login"
                          data-testid="tab-login"
                          className="data-[state=active]:bg-white dark:data-[state=active]:bg-brand data-[state=active]:text-gray-900 dark:data-[state=active]:text-brand-foreground"
                        >
                          {t("loginPage.rightPanel.tabs.signIn")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="register"
                          data-testid="tab-register"
                          className="data-[state=active]:bg-white dark:data-[state=active]:bg-brand data-[state=active]:text-gray-900 dark:data-[state=active]:text-brand-foreground"
                        >
                          {t("loginPage.rightPanel.tabs.signUp")}
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="login">
                        <form onSubmit={loginForm.handleSubmit(handleLogin)} className="space-y-4">
                          {isDemoMode && (
                            <div className="p-3.5 bg-brand/10 border border-brand/20 dark:bg-brand/5 rounded-lg text-xs space-y-2 text-gray-700 dark:text-gray-300 backdrop-blur-sm">
                              <div className="flex items-center justify-between">
                                <div className="font-semibold text-brand flex items-center gap-1.5">
                                  <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse"></span>
                                  Demo Credentials:
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setIsVideoOpen(true)}
                                  className="h-7 px-2.5 text-xs text-brand hover:text-brand hover:bg-brand/10 font-semibold flex items-center gap-1.5 rounded-md"
                                >
                                  <Play className="w-3.5 h-3.5 fill-current" />
                                  <span>Watch Demo Video</span>
                                </Button>
                              </div>
                              <div className="flex justify-between items-center flex-wrap gap-2">
                                <div>
                                  Email: <span className="font-mono bg-gray-100 dark:bg-[#0a1628] px-1.5 py-0.5 rounded text-gray-900 dark:text-gray-100 select-all font-semibold">demo@diploy.in</span>
                                </div>
                                <div>
                                  Password: <span className="font-mono bg-gray-100 dark:bg-[#0a1628] px-1.5 py-0.5 rounded text-gray-900 dark:text-gray-100 select-all font-semibold">Demo@1234</span>
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="space-y-2">
                            <Label htmlFor="login-email" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.email")}</Label>
                            <Input
                              id="login-email"
                              type="email"
                              placeholder={t("loginPage.rightPanel.form.emailPlaceholder")}
                              className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand"
                              {...loginForm.register("email")}
                              data-testid="input-login-email"
                            />
                            {loginForm.formState.errors.email && (
                              <p className="text-sm text-destructive">{loginForm.formState.errors.email.message}</p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="login-password" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.password")}</Label>
                            <div className="relative">
                              <Input
                                id="login-password"
                                type={showPassword ? "text" : "password"}
                                placeholder={t("loginPage.rightPanel.form.passwordPlaceholder")}
                                className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand pr-12"
                                {...loginForm.register("password")}
                                data-testid="input-login-password"
                              />
                              <button
                                type="button"
                                className="absolute right-0 top-0 h-full px-3 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                                onClick={() => setShowPassword(!showPassword)}
                                data-testid="button-toggle-password"
                              >
                                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                            {loginForm.formState.errors.password && (
                              <p className="text-sm text-destructive">{loginForm.formState.errors.password.message}</p>
                            )}
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  forgotPasswordForm.setValue("email", loginForm.getValues("email"));
                                  setActiveView("forgot-password");
                                }}
                                className="text-sm text-brand hover:underline cursor-pointer"
                                data-testid="link-forgot-password"
                              >
                                {t("loginPage.rightPanel.form.forgotPasswordLink")}
                              </button>
                            </div>
                          </div>

                          <Button
                            type="submit"
                            className="w-full h-12 bg-brand text-brand-foreground font-medium border-0 shadow-lg shadow-brand/25"
                            disabled={isLoading}
                            data-testid="button-login-submit"
                          >
                            {isLoading ? t("loginPage.rightPanel.form.signingIn") : t("loginPage.rightPanel.form.signInButton")}
                          </Button>
                        </form>
                      </TabsContent>

                      <TabsContent value="register">
                        <form onSubmit={registerForm.handleSubmit(handleSendRegistrationOTP)} className="space-y-4">
                          {isDemoMode && (
                            <div className="p-3.5 bg-brand/10 border border-brand/20 dark:bg-brand/5 rounded-lg text-xs space-y-2 text-gray-700 dark:text-gray-300 backdrop-blur-sm">
                              <div className="flex items-center justify-between">
                                <div className="font-semibold text-brand flex items-center gap-1.5">
                                  <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse"></span>
                                  Demo Mode Active
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setIsVideoOpen(true)}
                                  className="h-7 px-2.5 text-xs text-brand hover:text-brand hover:bg-brand/10 font-semibold flex items-center gap-1.5 rounded-md"
                                >
                                  <Play className="w-3.5 h-3.5 fill-current" />
                                  <span>Watch Demo Video</span>
                                </Button>
                              </div>
                            </div>
                          )}
                          <div className="space-y-2">
                            <Label htmlFor="register-name" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.fullName")}</Label>
                            <Input
                              id="register-name"
                              type="text"
                              placeholder={t("loginPage.rightPanel.form.fullNamePlaceholder")}
                              className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand"
                              {...registerForm.register("name")}
                              data-testid="input-register-name"
                            />
                            {registerForm.formState.errors.name && (
                              <p className="text-sm text-destructive">{registerForm.formState.errors.name.message}</p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="register-email" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.email")}</Label>
                            <Input
                              id="register-email"
                              type="email"
                              placeholder={t("loginPage.rightPanel.form.emailPlaceholder")}
                              className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand"
                              {...registerForm.register("email")}
                              data-testid="input-register-email"
                            />
                            {registerForm.formState.errors.email && (
                              <p className="text-sm text-destructive">{registerForm.formState.errors.email.message}</p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="register-password" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.password")}</Label>
                            <div className="relative">
                              <Input
                                id="register-password"
                                type={showPassword ? "text" : "password"}
                                placeholder={t("loginPage.rightPanel.form.createPassword")}
                                className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand pr-12"
                                {...registerForm.register("password")}
                                data-testid="input-register-password"
                              />
                              <button
                                type="button"
                                className="absolute right-0 top-0 h-full px-3 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                                onClick={() => setShowPassword(!showPassword)}
                              >
                                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                            {registerForm.formState.errors.password && (
                              <p className="text-sm text-destructive">{registerForm.formState.errors.password.message}</p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="register-confirm" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.confirmPassword")}</Label>
                            <Input
                              id="register-confirm"
                              type="password"
                              placeholder={t("loginPage.rightPanel.form.confirmPasswordPlaceholder")}
                              className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand"
                              {...registerForm.register("confirmPassword")}
                              data-testid="input-register-confirm"
                            />
                            {registerForm.formState.errors.confirmPassword && (
                              <p className="text-sm text-destructive">{registerForm.formState.errors.confirmPassword.message}</p>
                            )}
                          </div>

                          <Button
                            type="submit"
                            className="w-full h-12 bg-brand text-brand-foreground font-medium border-0 shadow-lg shadow-brand/25"
                            disabled={isLoading}
                            data-testid="button-register-submit"
                          >
                            {isLoading ? t("loginPage.rightPanel.form.sendingCode") : t("loginPage.rightPanel.form.sendCode")}
                          </Button>
                        </form>
                      </TabsContent>
                    </Tabs>
                  )}

                  {/* Registration OTP Verification */}
                  {activeView === "register-otp" && (
                    <form onSubmit={handleVerifyAndRegister} className="space-y-4">
                      <div className="text-center space-y-2 mb-4">
                        <div className="flex justify-center mb-4">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
                            <Mail className="h-6 w-6 text-brand" />
                          </div>
                        </div>
                        <h3 className="font-semibold text-lg text-gray-900 dark:text-white">{t("loginPage.rightPanel.form.checkEmail")}</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t("loginPage.rightPanel.form.sentCodeTo")}<br />
                          <strong className="text-gray-700 dark:text-gray-200">{registerForm.getValues().email}</strong>
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="register-otp" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.verificationCode")}</Label>
                        <Input
                          id="register-otp"
                          type="text"
                          placeholder={t("loginPage.rightPanel.form.otpPlaceholder")}
                          maxLength={6}
                          value={registerOtpCode}
                          onChange={(e) => setRegisterOtpCode(e.target.value.replace(/\D/g, ''))}
                          className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand text-center text-lg tracking-widest"
                          data-testid="input-register-otp"
                        />
                        {otpTimer > 0 && (
                          <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                            <span>{t("loginPage.rightPanel.form.codeExpires")} {Math.floor(otpTimer / 60)}:{String(otpTimer % 60).padStart(2, '0')}</span>
                          </div>
                        )}
                      </div>

                      <Button
                        type="submit"
                        className="w-full h-12 bg-brand text-brand-foreground font-medium border-0 shadow-lg shadow-brand/25"
                        disabled={isLoading || registerOtpCode.length !== 6}
                        data-testid="button-verify-register"
                      >
                        {isLoading ? t("loginPage.rightPanel.form.verifying") : t("loginPage.rightPanel.form.verifyButton")}
                      </Button>

                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="flex-1"
                          onClick={handleBackToRegisterDetails}
                          disabled={isLoading}
                          data-testid="button-back-register"
                        >
                          <ArrowLeft className="w-4 h-4 mr-2" />
                          {t("loginPage.rightPanel.form.back")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="flex-1"
                          onClick={handleResendRegistrationOTP}
                          disabled={isLoading || !canResendOtp}
                          data-testid="button-resend-register-otp"
                        >
                          {canResendOtp ? t("loginPage.rightPanel.form.resendCode") : t("loginPage.rightPanel.form.resendIn", { time: `${Math.floor(otpTimer / 60)}:${String(otpTimer % 60).padStart(2, '0')}` })}
                        </Button>
                      </div>
                    </form>
                  )}

                  {/* Forgot Password Form */}
                  {activeView === "forgot-password" && (
                    <form onSubmit={forgotPasswordForm.handleSubmit(handleForgotPasswordSubmit)} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="forgot-email" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.email")}</Label>
                        <Input
                          id="forgot-email"
                          type="email"
                          placeholder={t("loginPage.rightPanel.form.emailPlaceholder")}
                          className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand"
                          {...forgotPasswordForm.register("email")}
                          data-testid="input-forgot-email"
                        />
                        {forgotPasswordForm.formState.errors.email && (
                          <p className="text-sm text-destructive">{forgotPasswordForm.formState.errors.email.message}</p>
                        )}
                      </div>

                      <Button
                        type="submit"
                        className="w-full h-12 bg-brand text-brand-foreground font-medium border-0 shadow-lg shadow-brand/25"
                        disabled={isLoading}
                        data-testid="button-send-code"
                      >
                        {isLoading ? t("loginPage.rightPanel.form.sending") : t("loginPage.rightPanel.form.sendResetCode")}
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full"
                        onClick={() => setActiveView("login")}
                        data-testid="button-back-to-login"
                      >
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        {t("loginPage.rightPanel.form.backToLogin")}
                      </Button>
                    </form>
                  )}

                  {/* Reset Password Form */}
                  {activeView === "reset-password" && (
                    <form onSubmit={resetPasswordForm.handleSubmit(handleResetPassword)} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="reset-otp" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.verificationCode")}</Label>
                        <Input
                          id="reset-otp"
                          type="text"
                          placeholder={t("loginPage.rightPanel.form.otpPlaceholder")}
                          maxLength={6}
                          className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand text-center text-lg tracking-widest"
                          {...resetPasswordForm.register("otp")}
                          data-testid="input-reset-otp"
                        />
                        {resetPasswordForm.formState.errors.otp && (
                          <p className="text-sm text-destructive">{resetPasswordForm.formState.errors.otp.message}</p>
                        )}
                        <div className="flex justify-center">
                          {otpTimer > 0 ? (
                            <span className="text-sm text-gray-500">{t("loginPage.rightPanel.form.resendIn", { time: `${Math.floor(otpTimer / 60)}:${String(otpTimer % 60).padStart(2, '0')}` })}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={handleResendForgotPasswordOTP}
                              className="text-sm text-brand hover:underline"
                              disabled={isLoading}
                              data-testid="button-resend-otp"
                            >
                              {t("loginPage.rightPanel.form.resendCode")}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="reset-password" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.newPassword")}</Label>
                        <div className="relative">
                          <Input
                            id="reset-password"
                            type={showPassword ? "text" : "password"}
                            placeholder={t("loginPage.rightPanel.form.newPasswordPlaceholder")}
                            className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand pr-12"
                            {...resetPasswordForm.register("newPassword")}
                            data-testid="input-reset-password"
                          />
                          <button
                            type="button"
                            className="absolute right-0 top-0 h-full px-3 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                            onClick={() => setShowPassword(!showPassword)}
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        {resetPasswordForm.formState.errors.newPassword && (
                          <p className="text-sm text-destructive">{resetPasswordForm.formState.errors.newPassword.message}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="reset-confirm" className="text-gray-700 dark:text-gray-300">{t("loginPage.rightPanel.form.confirmNewPassword")}</Label>
                        <Input
                          id="reset-confirm"
                          type="password"
                          placeholder={t("loginPage.rightPanel.form.confirmNewPasswordPlaceholder")}
                          className="h-12 bg-gray-50 dark:bg-[#0a1628] border-gray-200 dark:border-brand/20 focus:border-brand dark:focus:border-brand"
                          {...resetPasswordForm.register("confirmPassword")}
                          data-testid="input-reset-confirm"
                        />
                        {resetPasswordForm.formState.errors.confirmPassword && (
                          <p className="text-sm text-destructive">{resetPasswordForm.formState.errors.confirmPassword.message}</p>
                        )}
                      </div>

                      <Button
                        type="submit"
                        className="w-full h-12 bg-brand text-brand-foreground font-medium border-0 shadow-lg shadow-brand/25"
                        disabled={isLoading}
                        data-testid="button-reset-password"
                      >
                        {isLoading ? t("loginPage.rightPanel.form.resetting") : t("loginPage.rightPanel.form.resetPassword")}
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full"
                        onClick={() => {
                          setActiveView("forgot-password");
                          resetPasswordForm.reset();
                        }}
                        data-testid="button-back-to-email"
                      >
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        {t("loginPage.rightPanel.form.changeEmail")}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            {/* Terms */}
            <p className="text-center text-sm text-gray-500 dark:text-gray-400">
              {t("loginPage.rightPanel.footer.agreement")}{" "}
              <Link href="/terms" className="text-brand hover:underline">{t("loginPage.rightPanel.footer.terms")}</Link>
              {" "}{t("loginPage.rightPanel.footer.and")}{" "}
              <Link href="/privacy" className="text-brand hover:underline">{t("loginPage.rightPanel.footer.privacy")}</Link>
            </p>

            {/* Trust indicators */}
            <motion.div
              className="flex items-center justify-center gap-6 pt-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <Check className="w-4 h-4 text-brand" />
                <span>{t("loginPage.rightPanel.trust.trial")}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <Check className="w-4 h-4 text-brand" />
                <span>{t("loginPage.rightPanel.trust.noCard")}</span>
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      {isDemoMode && (
        <Dialog open={isVideoOpen} onOpenChange={setIsVideoOpen}>
          <DialogContent className="sm:max-w-[850px] p-2 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <DialogHeader className="p-4 pb-2 text-left">
              <DialogTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Play className="h-5 w-5 text-emerald-400 fill-emerald-400" />
                {branding.app_name} {activeView === "register" ? "Sign Up" : "Live"} Demonstration
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                Watch how {branding.app_name} powers AI voice agents, outbound calls, and real-time voice workflows.
              </DialogDescription>
            </DialogHeader>
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-slate-800">
              {isVideoOpen && (
                <iframe
                  src={
                    activeView === "register"
                      ? "https://drive.google.com/file/d/1rZLRzQzf8N6TOhJlAGN1MxZJBCtkkstk/preview"
                      : "https://drive.google.com/file/d/12P10ehRmXueHJETBJM1-O66JFsvWKkV4/preview"
                  }
                  className="w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  title="AgentLabs Demo Video"
                />
              )}
            </div>
            <div className="p-3 pt-2 text-right">
              <a
                href={
                  activeView === "register"
                    ? "https://drive.google.com/file/d/1rZLRzQzf8N6TOhJlAGN1MxZJBCtkkstk/view?usp=sharing"
                    : "https://drive.google.com/file/d/12P10ehRmXueHJETBJM1-O66JFsvWKkV4/view?usp=sharing"
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand hover:underline inline-flex items-center gap-1 font-medium"
              >
                Open in Google Drive &rarr;
              </a>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}