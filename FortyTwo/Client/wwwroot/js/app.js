async function swalAlert(options) {
    return Swal.fire(options);
}

$(() => {
    return;

    // TODO: support theme options in /profile
    //  - use selected mode regardless of OS level setting

    const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');
    if (prefersDarkScheme.matches) {
        document.body.classList.add('dark-theme');
    } else {
        document.body.classList.remove('dark-theme');
    }
});
