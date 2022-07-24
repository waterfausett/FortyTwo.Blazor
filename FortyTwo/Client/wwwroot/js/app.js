async function swalAlert(options) {
    return Swal.fire(options);
}

$(() => {
});

applyThemePreferences();

function setThemePreferences(themeClassName) {
    if (!themeClassName) {
        localStorage.removeItem('profile-theme-preference');
    }
    else {
        localStorage.setItem('profile-theme-preference', themeClassName);
    }

    applyThemePreferences();
}

function applyThemePreferences() {
    document.body.classList.remove('dark-theme');
    document.body.classList.remove('light-theme');
    const profile_themePreference = localStorage.getItem('profile-theme-preference');

    if (profile_themePreference) {
        document.body.classList.add(profile_themePreference);
        return;
    }

    const prefersDarkSystemScheme = getSystemPrefersDarkTheme()
    if (prefersDarkSystemScheme) {
        document.body.classList.add('dark-theme');
    } else {
        document.body.classList.remove('dark-theme');
    }
}

function getSystemPrefersDarkTheme() {
    const prefersDarkSystemScheme = window.matchMedia('(prefers-color-scheme: dark)');
    return prefersDarkSystemScheme.matches;
}

function getUserPrefersDarkTheme() {
    const profile_themePreference = localStorage.getItem('profile-theme-preference');
    if (profile_themePreference) {
        return profile_themePreference == 'dark-theme';
    }

    return getSystemPrefersDarkTheme();
}